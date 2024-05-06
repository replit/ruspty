// Linux tests run with Bun

import fs from 'fs';
import { readdir, readlink } from 'node:fs/promises';
import { Pty } from '../index';
import assert from 'assert';

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';
const previousFDs: Record<string, string> = {};

// These two functions ensure that there are no extra open file descriptors after each test
// finishes. Only works on Linux.
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

describe('PTY', () => {
  test('spawns and exits', (done) => {
    const message = 'hello from a pty';

    const pty = new Pty({
      command: 'echo',
      args: [message],
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        pty.close();

        done();
      },
      onData: (err, chunk) => {
        expect(err).toBeNull();
        expect(chunk.toString()).toBe(message + '\r\n');
      },
    });
  });

  test('captures an exit code', (done) => {
    const pty = new Pty({
      command: 'sh',
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
    let buffer = '';

    const result = 'hello cat\r\nhello cat\r\n';

    const pty = new Pty({
      command: 'cat',
      onExit: () => {
        // We have local echo enabled, so we'll read the message twice.
        expect(buffer).toBe(result);

        pty.close();

        done();
      },
      onData: (err, data) => {
        expect(err).toBeNull();

        buffer += data;
      },
    });

    const writeStream = fs.createWriteStream('', { fd: pty.fd() });

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
    let buffer = '';

    const pty = new Pty({
      command: 'sh',
      size: { rows: 24, cols: 80 },
      onExit: () => {
        pty.close();

        done();
      },
      onData: (err, chunk) => {
        expect(err).toBeNull();

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
      },
    });

    const writeStream = fs.createWriteStream('', { fd: pty.fd() });

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
    const cwd = process.cwd();
    let buffer = '';

    const pty = new Pty({
      command: 'pwd',
      dir: cwd,
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer).toBe(`${cwd}\r\n`);
        pty.close();

        done();
      },
      onData: (err, data) => {
        expect(err).toBeNull();
        buffer += data.toString();
      },
    });
  });

  test('respects env', (done) => {
    const message = 'hello from env';
    let buffer: Buffer | undefined;

    const pty = new Pty({
      command: 'sh',
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
      onData: (err, data) => {
        expect(err).toBeNull();
        buffer = data;
      },
    });
  });

  test('works with Bun.read & Bun.write', (done) => {
    const message = 'hello bun\n';
    let buffer = '';
    const result = 'hello bun\r\nhello bun\r\n';

    const pty = new Pty({
      command: 'cat',
      onExit: () => {
        // We have local echo enabled, so we'll read the message twice. Furthermore, the newline
        // is converted to `\r\n` in this method.
        expect(buffer).toBe(result);
        pty.close();

        done();
      },
    });

    const file = Bun.file(pty.fd());

    async function read() {
      const stream = file.stream();
      for await (const chunk of stream) {
        buffer = Buffer.from(chunk).toString();
        // TODO: For some reason, Bun's stream will raise the EIO somewhere where we cannot catch
        // it, and make the test fail no matter how many try / catch blocks we add.
        break;
      }
    }

    read();
    Bun.write(pty.fd(), message + EOT + EOT);
  });

  // This test is not supported on Darwin at all.
  test('works with data callback', (done) => {
    const message = 'hello bun\n';
    let buffer = '';

    const pty = new Pty({
      command: 'cat',
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
  });

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
