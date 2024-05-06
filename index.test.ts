import fs from 'fs';
import os from 'node:os';
import { readdir, readlink } from 'node:fs/promises';
import { Pty } from './index';
import assert from 'assert';

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';
const previousFDs: Record<string, string> = {};

function macOSLinuxCatBufferCompare(
  b1: Buffer | Uint8Array,
  b2: Buffer | Uint8Array,
) {
  // macOS leaves these bytes when using `cat`, which linux does not
  //
  // so to be sure we drop them when comparing the expected to the received
  // buffer, we'll remove them from the output first, in a super crude manner
  const macOSStrayBytes = ',94,68,8,8';

  const a1 = Array.from(b1).toString().replaceAll(macOSStrayBytes, '');
  const a2 = Array.from(b2).toString().replaceAll(macOSStrayBytes, '');

  return a1 === a2;
}

// These two functions ensure that there are no extra open file descriptors after each test
// finishes. Only works on Linux.
if (os.type() !== 'Darwin') {
  beforeEach(async () => {
    for (const filename of await readdir(procSelfFd)) {
      try {
        previousFDs[filename] = await readlink(procSelfFd + filename);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          continue;
        }
        throw err;
      }
    }
  });
  afterEach(async () => {
    for (const filename of await readdir(procSelfFd)) {
      try {
        const linkTarget = await readlink(procSelfFd + filename);
        if (linkTarget === 'anon_inode:[timerfd]') {
          continue;
        }
        expect(previousFDs).toHaveProperty(filename, linkTarget);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          continue;
        }
        throw err;
      }
    }
  });
}

describe('PTY', () => {
  const CWD = process.cwd();

  test('spawns and exits', (done) => {
    const message = 'hello from a pty';
    let buffer = '';

    const pty = new Pty({
      command: '/bin/echo',
      args: [message],
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer).toBe(message + '\r\n');
        pty.close();

        done();
      },
    });

    const readStreamFd = pty.fd();
    const readStream = fs.createReadStream('', { fd: readStreamFd });

    readStream.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    readStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      console.log('err', { err });
      throw err;
    });
  });

  test('captures an exit code', (done) => {
    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'exit 17'],
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(17);
        pty.close();

        done();
      },
    });
  });

  test('can be written to', (done) => {
    // The message should end in newline so that the EOT can signal that the input has ended and not
    // just the line.
    const message = 'hello cat\n';
    let buffer: Buffer | undefined;

    const result = Buffer.from([
      104, 101, 108, 108, 111, 32, 99, 97, 116, 13, 10, 104, 101, 108, 108, 111,
      32, 99, 97, 116, 13, 10,
    ]);

    const pty = new Pty({
      command: '/bin/cat',
      onExit: () => {
        // We have local echo enabled, so we'll read the message twice.
        assert(buffer);
        expect(macOSLinuxCatBufferCompare(buffer, result)).toBe(true);
        pty.close();

        done();
      },
    });

    const readStream = fs.createReadStream('', { fd: pty.fd() });
    const writeStream = fs.createWriteStream('', { fd: pty.fd() });

    readStream.on('data', (chunk) => {
      assert(Buffer.isBuffer(chunk));
      buffer = chunk;
    });
    readStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });

    writeStream.write(message);
    writeStream.end(EOT);
    writeStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });
  });

  test('can be resized', (done) => {
    const pty = new Pty({
      command: '/bin/sh',
      size: { rows: 24, cols: 80 },
      onExit: () => {
        pty.close();

        done();
      },
    });

    const readStream = fs.createReadStream('', { fd: pty.fd() });
    const writeStream = fs.createWriteStream('', { fd: pty.fd() });

    let buffer = '';

    readStream.on('data', (chunk) => {
      buffer += chunk.toString();

      if (buffer.includes('done1\r\n')) {
        expect(buffer).toContain('24 80');
        pty.resize({ rows: 60, cols: 100 });
        buffer = '';
        writeStream.write("stty size; echo 'done2'\n");
      }

      if (buffer.includes('done2\r\n')) {
        expect(buffer).toContain('60 100');
      }
    });
    readStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });

    writeStream.write("stty size; echo 'done1'\n");
    writeStream.end(EOT);
    writeStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });
  });

  test('respects working directory', (done) => {
    let buffer = '';

    const pty = new Pty({
      command: '/bin/pwd',
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer).toBe(`${CWD}\r\n`);
        pty.close();

        done();
      },
    });

    const readStream = fs.createReadStream('', { fd: pty.fd() });

    readStream.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    readStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });
  });

  test('respects env', (done) => {
    const message = 'hello from env';
    let buffer: Buffer | undefined;

    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'echo $ENV_VARIABLE && exit'],
      envs: {
        ENV_VARIABLE: message,
      },
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        assert(buffer);
        expect(Buffer.compare(buffer, Buffer.from(message + '\r\n'))).toBe(0);
        pty.close();

        done();
      },
    });

    const readStream = fs.createReadStream('', { fd: pty.fd() });

    readStream.on('data', (chunk) => {
      assert(Buffer.isBuffer(chunk));
      buffer = chunk;
    });
    readStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });
  });

  test('works with Bun.read & Bun.write', (done) => {
    const message = 'hello bun\n';
    let buffer: Uint8Array | undefined;

    const result = new Uint8Array([
      104, 101, 108, 108, 111, 32, 98, 117, 110, 13, 10, 104, 101, 108, 108,
      111, 32, 98, 117, 110, 13, 10,
    ]);

    const pty = new Pty({
      command: '/bin/cat',
      onExit: () => {
        // We have local echo enabled, so we'll read the message twice. Furthermore, the newline
        // is converted to `\r\n` in this method.
        assert(buffer !== undefined);
        expect(macOSLinuxCatBufferCompare(buffer, result)).toBe(true);
        pty.close();

        done();
      },
    });

    const file = Bun.file(pty.fd());

    async function read() {
      const stream = file.stream();
      for await (const chunk of stream) {
        buffer = chunk;
        // TODO: For some reason, Bun's stream will raise the EIO somewhere where we cannot catch
        // it, and make the test fail no matter how many try / catch blocks we add.
        break;
      }
    }

    read();
    Bun.write(pty.fd(), message + EOT + EOT);
  });

  // This test is not supported on Darwin at all.
  (os.type() !== 'Darwin' ? test : test.skip)(
    'works with data callback',
    (done) => {
      const message = 'hello bun\n';
      let buffer = '';

      const pty = new Pty({
        command: '/bin/cat',
        onExit: () => {
          expect(buffer).toBe('hello bun\r\nhello bun\r\n');
          pty.close();

          done();
        },
        onData: (err, chunk) => {
          expect(err).toBeNull();
          buffer += chunk.toString();
        },
      });

      Bun.write(pty.fd(), message + EOT + EOT);
    },
  );

  test("doesn't break when executing non-existing binary", (done) => {
    try {
      new Pty({
        command: '/bin/this-does-not-exist',
        onExit: () => {},
      });
    } catch (e) {
      expect(e.message).toContain('No such file or directory');

      done();
    }
  });
});
