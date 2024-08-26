import { Pty, getCloseOnExec, setCloseOnExec } from '../wrapper';
import { type Writable } from 'stream';
import { readdirSync, readlinkSync } from 'fs';
import { describe, test, expect } from 'vitest';

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';
const IS_DARWIN = process.platform === 'darwin';

const testSkipOnDarwin = IS_DARWIN ? test.skip : test;

type FdRecord = Record<string, string>;
function getOpenFds(): FdRecord {
  const fds: FdRecord = {};
  if (process.platform !== 'linux') {
    return fds;
  }

  for (const filename of readdirSync(procSelfFd)) {
    try {
      const linkTarget = readlinkSync(procSelfFd + filename);
      if (
        linkTarget.startsWith('anon_inode:[') ||
        linkTarget.startsWith('socket:[') ||
        // node likes to asynchronously read stuff mid-test.
        linkTarget.includes('/ruspty/') ||
        linkTarget === '/dev/null'
      ) {
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

describe(
  'PTY',
  () => {
    test('spawns and exits', () =>
      new Promise<void>((done) => {
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
            done();
          },
        });

        const readStream = pty.read;
        readStream.on('data', (chunk) => {
          buffer = chunk.toString();
        });
      }));

    test('captures an exit code', () =>
      new Promise<void>((done) => {
        const oldFds = getOpenFds();
        new Pty({
          command: '/bin/sh',
          args: ['-c', 'exit 17'],
          onExit: (err, exitCode) => {
            expect(err).toBeNull();
            expect(exitCode).toBe(17);
            expect(getOpenFds()).toStrictEqual(oldFds);
            done();
          },
        });
      }));

    test('can be written to', () =>
      new Promise<void>((done) => {
        const oldFds = getOpenFds();

        // The message should end in newline so that the EOT can signal that the input has ended and not
        // just the line.
        const message = 'hello cat\n';
        let buffer = '';

        // We have local echo enabled, so we'll read the message twice.
        const expectedResult = 'hello cat\r\nhello cat\r\n';

        const pty = new Pty({
          command: '/bin/cat',
          onExit: (err, exitCode) => {
            expect(err).toBeNull();
            expect(exitCode).toBe(0);
            let result = buffer.toString();
            if (IS_DARWIN) {
              // Darwin adds the visible EOT to the stream.
              result = result.replace('^D\b\b', '');
            }
            expect(result.trim()).toStrictEqual(expectedResult.trim());
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

    test('can be started in non-interactive fashion', () =>
      new Promise<void>((done) => {
        const oldFds = getOpenFds();

        let buffer = '';

        const expectedResult = '\r\n';

        const pty = new Pty({
          command: '/bin/cat',
          interactive: false,
          onExit: (err, exitCode) => {
            expect(err).toBeNull();
            expect(exitCode).toBe(0);
            let result = buffer.toString();
            expect(result.trim()).toStrictEqual(expectedResult.trim());
            expect(getOpenFds()).toStrictEqual(oldFds);
            done();
          },
        });

        const readStream = pty.read;

        readStream.on('data', (data) => {
          buffer += data.toString();
        });
      }));

    test('can be resized', () =>
      new Promise<void>((done) => {
        const oldFds = getOpenFds();
        let buffer = '';
        let state: 'expectPrompt' | 'expectDone1' | 'expectDone2' | 'done' =
          'expectPrompt';
        const pty = new Pty({
          command: '/bin/sh',
          size: { rows: 24, cols: 80 },
          onExit: (err, exitCode) => {
            expect(err).toBeNull();
            expect(exitCode).toBe(0);

            expect(state).toBe('done');
            expect(getOpenFds()).toStrictEqual(oldFds);
            done();
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

    test('respects working directory', () =>
      new Promise<void>((done) => {
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

    test('respects env', () =>
      new Promise<void>((done) => {
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

    test(
      'ordering is correct',
      () =>
        new Promise<void>((done) => {
          const oldFds = getOpenFds();
          let buffer = Buffer.from('');
          const n = 1024;
          const pty = new Pty({
            command: '/bin/sh',
            args: [
              '-c',
              `for i in $(seq 0 ${n}); do /bin/echo $i; done && exit`,
            ],
            onExit: (err, exitCode) => {
              expect(err).toBeNull();
              expect(exitCode).toBe(0);
              expect(buffer.toString().trim()).toBe(
                [...Array(n + 1).keys()].join('\r\n'),
              );
              expect(getOpenFds()).toStrictEqual(oldFds);
              done();
            },
          });

          const readStream = pty.read;
          readStream.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
          });
        }),
      { repeats: 1 },
    );

    testSkipOnDarwin(
      'does not leak files',
      () =>
        new Promise<void>((done) => {
          const oldFds = getOpenFds();
          const promises = [];
          for (let i = 0; i < 10; i++) {
            promises.push(
              new Promise<void>((accept) => {
                let buffer = Buffer.from('');
                const pty = new Pty({
                  command: '/bin/sh',
                  args: ['-c', 'sleep 0.1 ; ls /proc/$$/fd'],
                  onExit: (err, exitCode) => {
                    expect(err).toBeNull();
                    expect(exitCode).toBe(0);
                    expect(
                      buffer
                        .toString()
                        .trim()
                        .split(/\s+/)
                        .filter((fd) => {
                          // Some shells dup stdio to fd 255 for reasons.
                          return fd !== '255';
                        })
                        .toSorted(),
                    ).toStrictEqual(['0', '1', '2']);
                    accept();
                  },
                });

                const readStream = pty.read;
                readStream.on('data', (data) => {
                  buffer = Buffer.concat([buffer, data]);
                });
              }),
            );
          }
          Promise.allSettled(promises).then(() => {
            expect(getOpenFds()).toStrictEqual(oldFds);
            done();
          });
        }),
      { repeats: 4 },
    );

    test(
      'can run concurrent shells',
      () =>
        new Promise<void>((done) => {
          const oldFds = getOpenFds();
          const donePromises: Array<Promise<void>> = [];
          const readyPromises: Array<Promise<void>> = [];
          const writeStreams: Array<Writable> = [];

          // We have local echo enabled, so we'll read the message twice.
          const expectedResult = 'ready\r\nhello cat\r\nhello cat\r\n';

          for (let i = 0; i < 10; i++) {
            donePromises.push(
              new Promise<void>((accept) => {
                let buffer = Buffer.from('');
                const pty = new Pty({
                  command: '/bin/sh',
                  args: ['-c', 'echo ready ; exec cat'],
                  onExit: (err, exitCode) => {
                    expect(err).toBeNull();
                    expect(exitCode).toBe(0);
                    let result = buffer.toString();
                    if (IS_DARWIN) {
                      // Darwin adds the visible EOT to the stream.
                      result = result.replace('^D\b\b', '');
                    }
                    expect(result).toStrictEqual(expectedResult);
                    accept();
                  },
                });

                readyPromises.push(
                  new Promise<void>((ready) => {
                    let readyMessageReceived = false;
                    const readStream = pty.read;
                    readStream.on('data', (data) => {
                      buffer = Buffer.concat([buffer, data]);
                      if (!readyMessageReceived) {
                        readyMessageReceived = true;
                        ready();
                      }
                    });
                  }),
                );
                writeStreams.push(pty.write);
              }),
            );
          }
          Promise.allSettled(readyPromises).then(() => {
            // The message should end in newline so that the EOT can signal that the input has ended and not
            // just the line.
            const message = 'hello cat\n';
            for (const writeStream of writeStreams) {
              writeStream.write(message);
              writeStream.end(EOT);
            }
          });
          Promise.allSettled(donePromises).then(() => {
            expect(getOpenFds()).toStrictEqual(oldFds);
            done();
          });
        }),
      { repeats: 4 },
    );

    test("doesn't break when executing non-existing binary", () =>
      new Promise<void>((done) => {
        const oldFds = getOpenFds();
        try {
          new Pty({
            command: '/bin/this-does-not-exist',
            onExit: () => {
              expect(getOpenFds()).toStrictEqual(oldFds);
            },
          });
        } catch (e: any) {
          expect(e.message).toContain('No such file or directory');

          done();
        }
      }));
  },
  { repeats: 50 },
);

describe('cgroup opts', () => {
  testSkipOnDarwin('basic cgroup', () => {
    // cat current cgroup and check if it matches cgroupPath
    const oldFds = getOpenFds();
    let buffer = '';
    const pty = new Pty({
      command: '/bin/cat',
      args: ['/proc/self/cgroup'],
      cgroupPath: '/sys/fs/cgroup/user.slice/test.slice',
      onExit: (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer.trim()).toBe('1');
        expect(getOpenFds()).toStrictEqual(oldFds);
      },
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer = data.toString();
    });
  });
});

describe('setCloseOnExec', () => {
  test('setCloseOnExec', () => {
    // stdio typically never has the close-on-exec flag since it's always expected to be
    // inheritable. But just to be safe, we'll keep it as it was when started.
    const originalFlag = getCloseOnExec(0);

    for (const closeOnExec of [true, false]) {
      setCloseOnExec(0, closeOnExec);
      expect(getCloseOnExec(0)).toBe(closeOnExec);
    }

    setCloseOnExec(0, originalFlag);
  });
});
