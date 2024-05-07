const { Pty } = require('../index');
const fs = require('fs');

const EOT = '\x04';

describe('PTY', () => {
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

    setImmediate(() => {
      const fd = pty.fd();
      const readStream = fs.createReadStream('', { fd });

      readStream.on('data', (chunk) => {
        buffer = chunk.toString();
      });
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
    let buffer = '';

    // We have local echo enabled, so we'll read the message twice.
    // `cat` on darwin also logs `^D`
    const result = 'hello cat\r\n^D\b\bhello cat\r\n';

    const pty = new Pty({
      command: '/bin/cat',
      onExit: () => {
        expect(buffer).toBe(result);

        pty.close();

        done();
      },
    });

    setImmediate(() => {
      const writeFd = pty.fd();
      const writeStream = fs.createWriteStream('', { fd: writeFd });

      const readFd = pty.fd();
      const readStream = fs.createReadStream('', { fd: readFd });

      readStream.on('data', (data) => {
        buffer += data.toString();
      });

      writeStream.write(message);
      writeStream.end(EOT);
      writeStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
    });
  });

  // TODO: fix this test on macOS
  test.skip('can be resized', (done) => {
    let buffer = '';

    const pty = new Pty({
      command: '/bin/sh',
      size: { rows: 24, cols: 80 },
      onExit: () => {
        pty.close();

        done();
      },
    });

    setImmediate(() => {
      const writeFd = pty.fd();
      const writeStream = fs.createWriteStream('', { fd: writeFd });

      const readFd = pty.fd();
      const readStream = fs.createReadStream('', { fd: readFd });

      readStream.on('data', (data) => {
        buffer += data.toString();

        console.log('buffer');
        console.log(buffer);
        console.log('-----');

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

      writeStream.write("stty size; echo 'done1'\n");
      writeStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
    });
  });

  // TODO: fix this test on macOS
  test.skip('respects working directory', (done) => {
    const cwd = process.cwd();
    let buffer = '';

    const pty = new Pty({
      command: '/bin/pwd',
      dir: cwd,
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer).toBe(`${cwd}\r\n`);
        pty.close();

        done();
      },
    });

    setImmediate(() => {
      const readFd = pty.fd();
      const readStream = fs.createReadStream('', { fd: readFd });

      readStream.on('data', (data) => {
        buffer += data.toString();
      });
    });
  });

  // TODO: fix this test on macOS
  test.skip('respects env', (done) => {
    const message = 'hello from env';
    let buffer;

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

    setImmediate(() => {
      const readFd = pty.fd();
      const readStream = fs.createReadStream('', { fd: readFd });

      readStream.on('data', (data) => {
        buffer += data.toString();
      });
    });
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
