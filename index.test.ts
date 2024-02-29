import fs from 'fs';
import { Pty } from './index';

describe('PTY', () => {
  const CWD = process.cwd();

  test('spawns and exits', (done) => {
    const message = 'hello from a pty';

    const pty = new Pty(
      'echo',
      [message],
      {},
      CWD,
      { rows: 24, cols: 80 },
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        done();
      },
    );

    const readStream = fs.createReadStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe(message + '\r\n');
    });
  });

  test('captures an exit code', (done) => {
    new Pty(
      'sh',
      ['-c', 'exit 17'],
      {},
      CWD,
      { rows: 24, cols: 80 },
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(17);
        done();
      },
    );
  });

  test('can be started many times', (done) => {
    const num = 100;
    let exited = Array.from({ length: num }).map(() => false);

    for (let i = 0; i < num; i++) {
      new Pty(
        'sh',
        ['-c', `exit 0`],
        {},
        CWD,
        { rows: 24, cols: 80 },
        (err, exitCode) => {
          exited[i] = true;
          expect(err).toBeNull();
          expect(exitCode).toBe(0);

          if (!exited.some((x) => x === false)) {
            done();
          }
        },
      );
    }
  });

  test('can be written to', (done) => {
    const message = 'hello cat';

    const pty = new Pty('cat', [], {}, CWD, { rows: 24, cols: 80 }, () => {});

    const readStream = fs.createReadStream('', { fd: pty.fd });
    const writeStream = fs.createWriteStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe(message);
      done();
    });

    writeStream.write(message);
  });

  test('can be resized', (done) => {
    const pty = new Pty('sh', [], {}, CWD, { rows: 24, cols: 80 }, () => {});

    const readStream = fs.createReadStream('', { fd: pty.fd });
    const writeStream = fs.createWriteStream('', { fd: pty.fd });

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
        done();
      }
    });

    writeStream.write("stty size; echo 'done1'\n");
  });

  test('respects working directory', (done) => {
    const pty = new Pty(
      'pwd',
      [],
      {},
      CWD,
      { rows: 24, cols: 80 },
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        done();
      },
    );

    const readStream = fs.createReadStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe(`${CWD}\r\n`);
    });
  });

  test('respects env', (done) => {
    const message = 'hello from env';
    let buffer = '';

    const pty = new Pty(
      'sh',
      ['-c', 'sleep 0.1s && echo $ENV_VARIABLE && exit'],
      {
        ENV_VARIABLE: message,
      },
      CWD,
      { rows: 24, cols: 80 },
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer).toBe(message + '\r\n');

        done();
      },
    );

    const readStream = fs.createReadStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      buffer += chunk.toString();
    });
  });

  test('works with Bun.read & Bun.write', (done) => {
    const message = 'hello bun';

    const pty = new Pty('cat', [], {}, CWD, { rows: 24, cols: 80 }, () => {});

    const file = Bun.file(pty.fd);

    async function read() {
      const stream = file.stream();

      for await (const chunk of stream) {
        expect(Buffer.from(chunk).toString()).toBe(message);
        done();
      }
    }

    read();

    Bun.write(pty.fd, message);
  });

  test("doesn't break when executing non-existing binary", (done) => {
    try {
      new Pty(
        '/bin/this-does-not-exist',
        [],
        {},
        CWD,
        { rows: 24, cols: 80 },
        () => {},
      );
    } catch (e) {
      expect(e.message).toContain('No such file or directory');

      done();
    }
  });
});
