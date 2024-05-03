import fs from 'fs';
import { Pty } from './index';

describe('PTY', () => {
  const CWD = process.cwd();
  const ENV = process.env as Record<string, string>;

  test('spawns and exits', (done) => {
    const message = 'hello from a pty';

    const pty = new Pty('echo', [message], ENV, CWD, { rows: 24, cols: 80 });

    const readStream = fs.createReadStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe(message + '\r\n');
    });

    pty.start((err, exitCode) => {
      expect(err).toBeNull();
      expect(exitCode).toBe(0);
      done();
    });
  });

  test('captures an exit code', (done) => {
    const pty = new Pty('sh', ['-c', 'exit 17'], ENV, CWD, {
      rows: 24,
      cols: 80,
    });

    pty.start((err, exitCode) => {
      expect(err).toBeNull();
      expect(exitCode).toBe(17);
      done();
    });
  });

  test('can be written to', (done) => {
    const message = 'hello cat';

    const pty = new Pty('cat', [], ENV, CWD, { rows: 24, cols: 80 });

    const readStream = fs.createReadStream('', { fd: pty.fd });
    const writeStream = fs.createWriteStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe(message);
      done();
    });

    pty.start(() => {});

    writeStream.write(message);
  });

  test('can be resized', (done) => {
    const pty = new Pty('sh', [], ENV, CWD, { rows: 24, cols: 80 });

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

    pty.start(() => {});

    writeStream.write("stty size; echo 'done1'\n");
  });

  test('respects working directory', (done) => {
    const pty = new Pty('pwd', [], ENV, CWD, { rows: 24, cols: 80 });

    const readStream = fs.createReadStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe(`${CWD}\r\n`);
    });

    pty.start((err, exitCode) => {
      expect(err).toBeNull();
      expect(exitCode).toBe(0);
      done();
    });
  });

  test.skip('respects env', (done) => {
    const message = 'hello from env';
    let buffer = '';

    const pty = new Pty(
      'sh',
      ['-c', 'echo $ENV_VARIABLE && exit'],
      {
        ...ENV,
        ENV_VARIABLE: message,
      },
      CWD,
      { rows: 24, cols: 80 },
    );

    const readStream = fs.createReadStream('', { fd: pty.fd });

    readStream.on('data', (chunk) => {
      buffer += chunk.toString();
    });

    pty.start((err, exitCode) => {
      expect(err).toBeNull();
      expect(exitCode).toBe(0);
      expect(buffer).toBe(message + '\r\n');

      done();
    });
  });

  test('works with Bun.read & Bun.write', (done) => {
    const message = 'hello bun';

    const pty = new Pty('cat', [], ENV, CWD, { rows: 24, cols: 80 });

    const file = Bun.file(pty.fd);

    async function read() {
      const stream = file.stream();

      for await (const chunk of stream) {
        expect(Buffer.from(chunk).toString()).toBe(message);
        done();
      }
    }

    read();

    pty.start(() => {});

    Bun.write(pty.fd, message);
  });

  test("doesn't break when executing non-existing binary", (done) => {
    const pty = new Pty('/bin/this-does-not-exist', [], ENV, CWD, {
      rows: 24,
      cols: 80,
    });

    try {
      pty.start(() => {});
    } catch (e) {
      expect(e.message).toContain('No such file or directory');

      done();
    }
  });

  test('can start the process at an arbitrary later point in time', (done) => {
    const allFinished = {
      dataChunk: false,
      startResult: false,
      startCallback: false,
    };

    function checkDone() {
      if (Object.values(allFinished).every((d) => d === true)) {
        done();
      }
    }

    const pty = new Pty('echo', ['hello world'], ENV, CWD, {
      rows: 24,
      cols: 80,
    });

    const readStream = fs.createReadStream('', { fd: pty.fd, start: 0 });

    readStream.on('data', (chunk) => {
      expect(chunk.toString()).toBe('hello world\r\n');
      allFinished.dataChunk = true;
      checkDone();
    });

    setTimeout(() => {
      const startResult = pty.start((err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        allFinished.startCallback = true;
        checkDone();
      });

      expect(startResult.pid).toBeGreaterThan(0);
      allFinished.startResult = true;
      checkDone();
    }, 100);
  });
});
