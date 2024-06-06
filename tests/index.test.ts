import { Pty } from '../index';
import fs, { readdirSync, readlinkSync } from 'fs';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';

function createReadStreamFromPty(pty: Pty) {
  const fd = pty.fd();
  return fs.createReadStream('', { fd, autoClose: false });
}

function createWriteStreamToPty(pty: Pty) {
  const fd = pty.fd();
  return fs.createWriteStream('', { fd, autoClose: false });
}

const rejectOnNonEIO = (reject: (reason?: Error) => void) => (err: NodeJS.ErrnoException) => {
  if (err.code && err.code.indexOf('EIO') !== -1) {
    return;
  }

  reject(err);
}

type FdRecord = Record<string, string>;
function getOpenFds(): FdRecord {
  const fds: FdRecord = {};
  if (process.platform !== 'linux') {
    return fds;
  }

  for (const filename of readdirSync(procSelfFd)) {
    try {
      const linkTarget = readlinkSync(procSelfFd + filename);
      if (linkTarget === 'anon_inode:[timerfd]') {
        continue;
      }

      fds[filename] = linkTarget;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }

  return fds;
}

describe('PTY', () => {
  let pty: Pty;
  let oldFds: FdRecord;

  beforeEach(() => {
    oldFds = getOpenFds();
  })

  afterEach(() => {
    pty.close();
    expect(getOpenFds()).toStrictEqual(oldFds);
  })

  test('spawns and exits', () => new Promise<void>((done, reject) => {
    const message = 'hello from a pty';
    let buffer = '';

    pty = new Pty({
      command: '/bin/echo',
      args: [message],
      onExit: async (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        vi.waitFor(() => expect(buffer.trim()).toBe(message));
        done();
      },
    });

    const readStream = createReadStreamFromPty(pty);
    readStream.on('data', (chunk) => {
      buffer = chunk.toString();
    });
    readStream.on('error', rejectOnNonEIO(reject));
  }));

  test('captures an exit code', () => new Promise<void>((done) => {
    pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'exit 17'],
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(17);
        done();
      },
    });
  }));

  test('can be written to', () => new Promise<void>((done, reject) => {
    // The message should end in newline so that the EOT can signal that the input has ended and not
    // just the line.
    const message = 'hello cat\n';
    let buffer = '';

    // We have local echo enabled, so we'll read the message twice.
    const result = process.platform === "darwin"
      ? 'hello cat\r\n^D\b\bhello cat\r\n'
      : 'hello cat\r\nhello cat\r\n';

    pty = new Pty({
      command: '/bin/cat',
      onExit: () => {
        vi.waitFor(() => expect(buffer.trim()).toBe(result.trim()));
        done();
      },
    });

    const writeStream = createWriteStreamToPty(pty);
    const readStream = createReadStreamFromPty(pty);

    readStream.on('data', (data) => {
      buffer += data.toString();
    });
    readStream.on('error', rejectOnNonEIO(reject));
    writeStream.write(message);
    writeStream.end(EOT);
    writeStream.on('error', rejectOnNonEIO(reject));
  }));

  test('can be resized', () => new Promise<void>((done, reject) => {
    let buffer = '';
    pty = new Pty({
      command: '/bin/sh',
      size: { rows: 24, cols: 80 },
      onExit: () => done(),
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
        return;
      }

      if (buffer.includes('done2\r\n')) {
        expect(buffer).toContain('60 100');

        writeStream.write(EOT);
        return;
      }
    });
    readStream.on('error', rejectOnNonEIO(reject));
    writeStream.write("stty size; echo 'done1'\n");
    writeStream.on('error', rejectOnNonEIO(reject));
  }));

  test('respects working directory', () => new Promise<void>((done, reject) => {
    const cwd = process.cwd();
    let buffer = '';

    pty = new Pty({
      command: '/bin/pwd',
      dir: cwd,
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        vi.waitFor(() => expect(buffer.trim()).toBe(cwd));

        done();
      },
    });

    const readStream = createReadStreamFromPty(pty);
    readStream.on('data', (data) => {
      buffer += data.toString();
    });
    readStream.on('error', rejectOnNonEIO(reject));
  }));

  test('respects env', () => new Promise<void>((done, reject) => {
    const message = 'hello from env';
    let buffer = '';

    pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'echo $ENV_VARIABLE && exit'],
      envs: {
        ENV_VARIABLE: message,
      },
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        vi.waitFor(() => expect(buffer.trim()).toBe(message));

        done();
      },
    });

    const readStream = createReadStreamFromPty(pty);
    readStream.on('data', (data) => {
      buffer += data.toString();
    });
    readStream.on('error', rejectOnNonEIO(reject));
  }));

  test("doesn't break when executing non-existing binary", () => new Promise<void>((done) => {
    try {
      pty = new Pty({
        command: '/bin/this-does-not-exist',
        onExit: () => { },
      });
    } catch (e: any) {
      expect(e.message).toContain('No such file or directory');

      done();
    }
  }));
}, { repeats: 5 });
