// Linux tests run with Node

import fs from 'fs';
import { readdir, readlink } from 'node:fs/promises';
import { Pty } from '../index';
import assert from 'assert';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';
const previousFDs = {};

// These two functions ensure that there are no extra open file descriptors after each test
// finishes. Only works on Linux.
beforeEach(async () => {
  for (const filename of await readdir(procSelfFd)) {
    try {
      previousFDs[filename] = await readlink(procSelfFd + filename);
    } catch (err) {
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
    } catch (err) {
      if (err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }
});

describe('PTY', () => {
  test('spawns and exits', () => {
    return new Promise((resolve) => {
      const message = 'hello from a pty';

      const pty = new Pty({
        command: 'echo',
        args: [message],
        onExit: (err, exitCode) => {
          expect(err).toBeNull();
          expect(exitCode).toBe(0);
          pty.close();

          resolve();
        },
        onData: (err, chunk) => {
          expect(err).toBeNull();
          expect(chunk.toString()).toBe(message + '\r\n');
        },
      });
    });
  });

  test('captures an exit code', () => {
    return new Promise((resolve) => {
      const pty = new Pty({
        command: 'sh',
        args: ['-c', 'exit 17'],
        onExit: (err, exitCode) => {
          expect(err).toBeNull();
          expect(exitCode).toBe(17);
          pty.close();

          resolve();
        },
      });
    });
  });

  test('can be written to', () => {
    return new Promise((resolve) => {
      // The message should end in newline so that the EOT can signal that the input has ended and not
      // just the line.
      const message = 'hello cat\n';
      let buffer = '';

      // We have local echo enabled, so we'll read the message twice.
      const result = 'hello cat\r\nhello cat\r\n';

      const pty = new Pty({
        command: 'cat',
        onExit: () => {
          expect(buffer).toBe(result);

          pty.close();

          resolve();
        },
      });

      const writeStream = fs.createWriteStream('', { fd: pty.fd() });
      const readStream = fs.createReadStream('', { fd: pty.fd() });

      readStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
      readStream.on('data', (chunk) => {
        buffer += chunk.toString();
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

  test('can be resized', () => {
    return new Promise((resolve) => {
      let buffer = '';

      const pty = new Pty({
        command: 'sh',
        size: { rows: 24, cols: 80 },
        envs: { PATH: process.env.PATH ?? '' },
        onExit: () => {
          pty.close();

          resolve();
        },
      });

      const writeStream = fs.createWriteStream('', { fd: pty.fd() });
      const readStream = fs.createReadStream('', { fd: pty.fd() });

      readStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
      readStream.on('data', (chunk) => {
        buffer += chunk.toString();

        if (buffer.includes('done1\r\n')) {
          expect(buffer).toContain('24 80');
          pty.resize({ rows: 60, cols: 100 });
          buffer = '';
          writeStream.write("stty size; echo 'done2'\n");
          writeStream.end(EOT);
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

  test('respects working directory', () => {
    return new Promise((resolve) => {
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

          resolve();
        },
      });

      const readStream = fs.createReadStream('', { fd: pty.fd() });

      readStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
      readStream.on('data', (chunk) => {
        buffer += chunk.toString();
      });
    });
  });

  test('respects env', () => {
    return new Promise((resolve) => {
      const message = 'hello from env';
      let buffer = '';

      const pty = new Pty({
        command: 'sh',
        args: ['-c', 'echo $ENV_VARIABLE && exit'],
        envs: {
          PATH: process.env.PATH ?? '',
          ENV_VARIABLE: message,
        },
        onExit: (err, exitCode) => {
          expect(err).toBeNull();
          expect(exitCode).toBe(0);
          assert(buffer);
          expect(buffer).toBe(message + '\r\n');
          pty.close();

          resolve();
        },
      });

      const readStream = fs.createReadStream('', { fd: pty.fd() });

      readStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
      readStream.on('data', (chunk) => {
        buffer += chunk.toString();
      });
    });
  });

  test('no extra stuff ends up in env', () => {
    return new Promise((resolve) => {
      let buffer = '';

      const pty = new Pty({
        command: 'env',
        envs: {
          PATH: process.env.PATH ?? '',
          ENV_VARIABLE: '1',
        },
        onExit: (err) => {
          expect(err).toBeNull();

          const lines = buffer.split('\r\n').filter((l) => l.length > 0);
          expect(lines.length).toBe(2);
          expect(lines.filter((l) => l.startsWith('PATH='))).toHaveLength(1);
          expect(
            lines.filter((l) => l.startsWith('ENV_VARIABLE=')),
          ).toHaveLength(1);

          pty.close();

          resolve();
        },
      });

      const readStream = fs.createReadStream('', { fd: pty.fd() });

      readStream.on('error', (err) => {
        if (err.code && err.code.indexOf('EIO') !== -1) {
          return;
        }
        throw err;
      });
      readStream.on('data', (chunk) => {
        buffer += chunk.toString();
      });
    });
  });

  test("doesn't break when executing non-existing binary", () => {
    return new Promise((resolve) => {
      try {
        new Pty({
          command: '/bin/this-does-not-exist',
          onExit: () => {},
        });
      } catch (e) {
        expect(e.message).toContain('No such file or directory');

        resolve();
      }
    });
  });
});
