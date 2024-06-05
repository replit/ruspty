import { Pty } from '../index';
import assert from 'assert';
import fs from 'fs';
import { describe, test, expect } from 'vitest';

const EOT = '\x04';

function createReadStreamFromPty(pty: Pty) {
  return fs.createReadStream('', { fd: pty.fd(), start: 0, autoClose: true });
}

function createWriteStreamToPty(pty: Pty) {
  return fs.createWriteStream('', { fd: pty.fd(), start: 0 });
}

describe('PTY', () => {
  test.only('spawns and exits', () => new Promise<void>((done) => {
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

    const readStream = createReadStreamFromPty(pty);
    readStream.on('data', (chunk) => {
      buffer = chunk.toString();
    });
  }));

  test('captures an exit code', () => new Promise<void>((done) => {
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
  }));

  test('can be written to', () => new Promise<void>((done) => {
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

    const writeStream = createWriteStreamToPty(pty);
    const readStream = createReadStreamFromPty(pty);

    readStream.on('data', (data) => {
      buffer += data.toString();
    });

    writeStream.write(message);
    writeStream.end(EOT);
    writeStream.on('error', (err: any) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });
  }));

  test('can be resized', () => new Promise<void>((done) => {
    let buffer = '';

    const pty = new Pty({
      command: '/bin/sh',
      size: { rows: 24, cols: 80 },
      onExit: () => {
        pty.close();

        done();
      },
    });

    const writeStream = createWriteStreamToPty(pty);
    const readStream = createReadStreamFromPty(pty);

    readStream.on('data', (data) => {
      buffer += data.toString();

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
    writeStream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        return;
      }
      throw err;
    });
  }));

  test('respects working directory', () => new Promise<void>((done) => {
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

    const readStream = createReadStreamFromPty(pty);
    readStream.on('data', (data) => {
      buffer += data.toString();
    });
  }));

  test('respects env', () => new Promise<void>((done) => {
    const message = 'hello from env';
    let buffer: string;

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
        expect(Buffer.compare(Buffer.from(buffer), Buffer.from(message + '\r\n'))).toBe(0);
        pty.close();

        done();
      },
    });

    const readStream = createReadStreamFromPty(pty);
    readStream.on('data', (data) => {
      buffer += data.toString();
    });
  }));

  test("doesn't break when executing non-existing binary", () => new Promise<void>((done) => {
    try {
      new Pty({
        command: '/bin/this-does-not-exist',
        onExit: () => { },
      });
    } catch (e: any) {
      expect(e.message).toContain('No such file or directory');

      done();
    }
  }));
});
