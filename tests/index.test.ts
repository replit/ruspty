import { Pty } from '../wrapper';
import { readdirSync, readlinkSync } from 'fs';
import { describe, test, expect } from 'vitest';

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';

type FdRecord = Record<string, string>;
function getOpenFds(): FdRecord {
  const fds: FdRecord = {};
  if (process.platform !== 'linux') {
    return fds;
  }

  for (const filename of readdirSync(procSelfFd)) {
    try {
      const linkTarget = readlinkSync(procSelfFd + filename);
      if (linkTarget === 'anon_inode:[timerfd]' || linkTarget.startsWith("socket:[")) {
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

  test('spawns and exits', () => new Promise<void>(done => {
    const oldFds = getOpenFds();
    const message = 'hello from a pty';
    let buffer = '';

    const pty = new Pty({
      command: '/bin/echo',
      args: [message],
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer.trim()).toBe(message);
        expect(getOpenFds()).toStrictEqual(oldFds);
        done()
      },
    });

    const readStream = pty.read;
    readStream.on('data', (chunk) => {
      buffer = chunk.toString();
    });
  }));

  test('captures an exit code', () => new Promise<void>(done => {
    const oldFds = getOpenFds();
    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'exit 17'],
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(17);
        pty.close();
        expect(getOpenFds()).toStrictEqual(oldFds);
        done();
      },
    });
  }));

  test('can be written to', () => new Promise<void>(done => {
    const oldFds = getOpenFds();

    // The message should end in newline so that the EOT can signal that the input has ended and not
    // just the line.
    const message = 'hello cat\n';
    let buffer = '';

    // We have local echo enabled, so we'll read the message twice.
    const result = process.platform === "darwin"
      ? 'hello cat\r\n^D\b\bhello cat\r\n'
      : 'hello cat\r\nhello cat\r\n';

    const pty = new Pty({
      command: '/bin/cat',
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer.trim()).toBe(result.trim());
        expect(getOpenFds()).toStrictEqual(oldFds);
        done();
      },
    });

    const writeStream = pty.write;
    const readStream = pty.read;

    readStream.on('data', (data) => {
      buffer += data.toString();
    });
    writeStream.write(message);
    writeStream.end(EOT);
  }));

  test('can be resized', () => new Promise<void>(done => {
    const oldFds = getOpenFds();
    let buffer = '';
    let state: 'expectPrompt' | 'expectDone1' | 'expectDone2' | 'done' = 'expectPrompt';
    const pty = new Pty({
      command: '/bin/sh',
      size: { rows: 24, cols: 80 },
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);

        expect(state).toBe('done');
        expect(getOpenFds()).toStrictEqual(oldFds);
        done()
      },
    });

    const writeStream = pty.write;
    const readStream = pty.read;

    readStream.on('data', (data) => {
      buffer += data.toString();

      if (state === 'expectPrompt' && buffer.endsWith('$ ')) {
        writeStream.write("stty size; echo 'done1'\n");
        state = 'expectDone1';
        return;
      }

      if (state === 'expectDone1' && buffer.includes('done1\r\n')) {
        state = 'expectDone2';
        expect(buffer).toContain('24 80');
        pty.resize({ rows: 60, cols: 100 });

        writeStream.write("stty size; echo 'done2'\n");
        return;
      }

      if (state === 'expectDone2' && buffer.includes('done2\r\n')) {
        expect(buffer).toContain('60 100');
        state = 'done';

        writeStream.write(EOT);
        return;
      }
    });

  }));

  test('respects working directory', () => new Promise<void>(done => {
    const oldFds = getOpenFds();
    const cwd = process.cwd();
    let buffer = '';

    const pty = new Pty({
      command: '/bin/pwd',
      dir: cwd,
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer.trim()).toBe(cwd);
        expect(getOpenFds()).toStrictEqual(oldFds);
        done();
      },
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer += data.toString();
    });
  }));

  test('respects env', () => new Promise<void>(done => {
    const oldFds = getOpenFds();
    const message = 'hello from env';
    let buffer = '';

    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'echo $ENV_VARIABLE && exit'],
      envs: {
        ENV_VARIABLE: message,
      },
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer.trim()).toBe(message);
        expect(getOpenFds()).toStrictEqual(oldFds);
        done();
      },
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer += data.toString();
    });
  }));

  test("doesn't break when executing non-existing binary", () => new Promise<void>((done) => {
    const oldFds = getOpenFds();
    try {
      const pty = new Pty({
        command: '/bin/this-does-not-exist',
        onExit: () => {
          pty.close();
          expect(getOpenFds()).toStrictEqual(oldFds);
        },
      });
    } catch (e: any) {
      expect(e.message).toContain('No such file or directory');

      done();
    }
  }));
}, { repeats: 1000 });
