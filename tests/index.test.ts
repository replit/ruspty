import { Pty, getCloseOnExec, setCloseOnExec, Operation } from '../wrapper';
import { type Writable } from 'stream';
import { readdirSync, readlinkSync } from 'fs';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
  assert,
} from 'vitest';
import { exec as execAsync } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execAsync);

const EOT = '\x04';
const procSelfFd = '/proc/self/fd/';
const IS_DARWIN = process.platform === 'darwin';

const testSkipOnDarwin = IS_DARWIN ? test.skip : test;
const testOnlyOnDarwin = IS_DARWIN ? test : test.skip;

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

describe('PTY', { repeats: 500 }, () => {
  test('spawns and exits', async () => {
    const oldFds = getOpenFds();
    const message = 'hello from a pty';
    let buffer = '';

    const onExit = vi.fn();
    const pty = new Pty({
      command: '/bin/echo',
      args: [message],
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (chunk) => {
      buffer = chunk.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(buffer.trim()).toBe(message);
    expect(getOpenFds()).toStrictEqual(oldFds);
    expect(pty.write.writable).toBe(false);
    expect(pty.read.readable).toBe(false);
  });

  test('captures an exit code', async () => {
    const oldFds = getOpenFds();
    const onExit = vi.fn();
    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'exit 17'],
      onExit,
    });

    // set a pty reader so it can flow
    pty.read.on('data', () => {});

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 17);
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('can be written to', async () => {
    const oldFds = getOpenFds();
    const message = 'hello cat\n';
    let buffer = '';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/cat',
      onExit,
    });

    const writeStream = pty.write;
    const readStream = pty.read;

    readStream.on('data', (data) => {
      buffer += data.toString();
    });

    writeStream.write(message);
    writeStream.end(EOT);

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(pty.write.writable).toBe(false);

    let result = buffer.toString();
    if (IS_DARWIN) {
      // Darwin adds the visible EOT to the stream.
      result = result.replace('^D\b\b', '');
    }

    const expectedResult = 'hello cat\r\nhello cat\r\n';
    expect(result.trim()).toStrictEqual(expectedResult.trim());
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('can be started in non-interactive fashion', async () => {
    const oldFds = getOpenFds();
    let buffer = '';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/cat',
      interactive: false,
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer += data.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);

    let result = buffer.toString();
    const expectedResult = '\r\n';
    expect(result.trim()).toStrictEqual(expectedResult.trim());
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('can be resized', async () => {
    const oldFds = getOpenFds();
    let buffer = '';
    let state: 'expectPrompt' | 'expectDone1' | 'expectDone2' | 'done' =
      'expectPrompt';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/sh',
      size: { rows: 24, cols: 80 },
      onExit,
    });

    const writeStream = pty.write;
    const readStream = pty.read;

    const statePromise = new Promise<void>((resolve) => {
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
          resolve();
        }
      });
    });

    await statePromise;
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(state).toBe('done');
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('respects working directory', async () => {
    const oldFds = getOpenFds();
    const cwd = process.cwd();
    let buffer = '';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/pwd',
      dir: cwd,
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer += data.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(buffer.trim()).toBe(cwd);
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('respects env', async () => {
    const oldFds = getOpenFds();
    const message = 'hello from env';
    let buffer = '';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'echo $ENV_VARIABLE && exit'],
      envs: {
        ENV_VARIABLE: message,
      },
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer += data.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(buffer.trim()).toBe(message);
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test("resize after exit shouldn't throw", async () => {
    const onExit = vi.fn();
    const pty = new Pty({
      command: '/bin/echo',
      args: ['hello'],
      onExit,
    });

    pty.read.on('data', () => {});

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(() => {
      pty.resize({ rows: 60, cols: 100 });
    }).not.toThrow();
  });

  test("resize after close shouldn't throw", async () => {
    const onExit = vi.fn();
    const pty = new Pty({
      command: '/bin/sh',
      onExit,
    });

    pty.read.on('data', () => {});

    pty.close();
    expect(() => {
      pty.resize({ rows: 60, cols: 100 });
    }).not.toThrow();

    process.kill(pty.pid, 'SIGKILL');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, -1);
    expect(pty.write.writable).toBe(false);
    expect(pty.read.readable).toBe(false);
  });

  test('ordering is correct', async () => {
    const oldFds = getOpenFds();
    let buffer = Buffer.from('');
    const n = 1024;
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', `seq 0 ${n}`],
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);

    const lines = buffer.toString().trim().split('\n');
    expect(lines.length).toBe(n + 1);
    for (let i = 0; i < n + 1; i++) {
      expect(
        Number(lines[i]),
        `expected line ${i} to contain ${i} but got ${lines[i]}`,
      ).toBe(i);
    }

    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('doesnt miss large output from fast commands', async () => {
    const payload = `hello`.repeat(4096);
    let buffer = Buffer.from('');
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/echo',
      args: ['-n', payload],
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(buffer.toString().length).toBe(payload.length);
  });

  testSkipOnDarwin('does not leak files', async () => {
    const oldFds = getOpenFds();
    const promises = [];

    for (let i = 0; i < 10; i++) {
      const onExit = vi.fn();
      let buffer = Buffer.from('');

      const pty = new Pty({
        command: '/bin/sh',
        args: ['-c', 'sleep 0.1 ; ls /proc/$$/fd'],
        onExit,
      });

      const readStream = pty.read;
      readStream.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
      });

      promises.push(
        vi
          .waitFor(() => expect(onExit).toHaveBeenCalledTimes(1))
          .then(() => {
            expect(onExit).toHaveBeenCalledWith(null, 0);
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
          }),
      );
    }

    await Promise.all(promises);
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('can run concurrent shells', async () => {
    const oldFds = getOpenFds();
    const writeStreams: Array<Writable> = [];
    const buffers: Array<Buffer> = [];
    const onExits: Array<Mock> = [];
    const expectedResult = 'hello cat\r\nhello cat\r\n';

    // Create 10 concurrent shells
    for (let i = 0; i < 10; i++) {
      const onExit = vi.fn();
      onExits.push(onExit);
      buffers[i] = Buffer.from('');

      const pty = new Pty({
        command: '/bin/cat',
        onExit,
      });

      const readStream = pty.read;
      readStream.on('data', (data) => {
        buffers[i] = Buffer.concat([buffers[i], data]);
      });

      writeStreams.push(pty.write);
      pty.write.write('hello cat\n');
    }

    // Wait for initial output
    await vi.waitFor(() =>
      buffers.every((buffer) => buffer.toString().includes('hello cat\r\n')),
    );

    // Send EOT to all shells
    for (const writeStream of writeStreams) {
      writeStream.end(EOT);
    }

    // Wait for all shells to exit
    await Promise.all(
      onExits.map((onExit) =>
        vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1)),
      ),
    );

    // Verify results
    for (let i = 0; i < 10; i++) {
      expect(onExits[i]).toHaveBeenCalledWith(null, 0);
      let result = buffers[i].toString();
      if (IS_DARWIN) {
        result = result.replace('^D\b\b', '');
      }
      expect(result).toStrictEqual(expectedResult);
    }

    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test("doesn't break when executing non-existing binary", async () => {
    const oldFds = getOpenFds();

    await expect(async () => {
      new Pty({
        command: '/bin/this-does-not-exist',
        onExit: () => {},
      });
    }).rejects.toThrow('No such file or directory');

    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  test('cannot be written to after closing', async () => {
    const oldFds = getOpenFds();
    const onExit = vi.fn();
    const pty = new Pty({
      command: '/bin/echo',
      args: ['hello'],
      onExit,
    });

    const readStream = pty.read;
    const writeStream = pty.write;

    readStream.on('data', () => {});

    pty.close();

    assert(!writeStream.writable);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    let receivedError = false;
    writeStream.write('hello2', (error) => {
      if (error) {
        receivedError = true;
      }
    });
    await vi.waitFor(() => receivedError);
    expect(getOpenFds()).toStrictEqual(oldFds);
  });
});

describe('cgroup opts', async () => {
  let SLICE_DIR: string;
  let ORIGINAL_CGROUP: string;
  let SLICE: string;
  if (!IS_DARWIN) {
    const CG_ROOT = '/sys/fs/cgroup';
    // unique slice name to avoid conflicts with other test runs
    SLICE = `ruspty-${Math.random().toString(36).substring(2, 15)}`;
    SLICE_DIR = join(CG_ROOT, SLICE);

    // Get the current process's cgroup path to restore it later
    const CGROUP_RAW = (await exec(`cat /proc/self/cgroup`)).stdout.trim();
    // Extract just the path portion from the cgroup format (e.g., "0::/user.slice/...")
    const CGROUP_PATH = CGROUP_RAW.split(':').pop() || '';
    // Construct the full filesystem path to the original cgroup
    ORIGINAL_CGROUP = join(CG_ROOT, CGROUP_PATH.replace(/^\//, ''));
  }

  beforeEach(async () => {
    if (!IS_DARWIN) {
      // create the slice - this is the cgroup that will be used for testing
      await exec(`sudo mkdir -p ${SLICE_DIR}`);
      await exec(`sudo chown -R $(id -u):$(id -g) ${SLICE_DIR}`);

      // add the current process to the slice
      // so the spawned pty inherits the slice - this is important because
      // child processes inherit their parent's cgroup by default
      await exec(`echo ${process.pid} | sudo tee ${SLICE_DIR}/cgroup.procs`);
    }
  });

  afterEach(async () => {
    if (!IS_DARWIN) {
      // remove the current process from the test slice and return it to its original cgroup
      // so it can be deleted
      await exec(
        `echo ${process.pid} | sudo tee ${ORIGINAL_CGROUP}/cgroup.procs`,
      );
      await exec(`sudo rmdir ${SLICE_DIR}`);
    }
  });

  testSkipOnDarwin('basic cgroup', async () => {
    const oldFds = getOpenFds();
    let buffer = '';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/cat',
      args: ['/proc/self/cgroup'],
      cgroupPath: SLICE_DIR,
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer = data.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    // Verify that the process was placed in the correct cgroup by
    // checking its output contains our unique slice name
    expect(buffer).toContain(SLICE);
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  testOnlyOnDarwin('cgroup is not supported on darwin', async () => {
    expect(() => {
      new Pty({
        command: '/bin/cat',
        args: ['/proc/self/cgroup'],
        cgroupPath: '/sys/fs/cgroup/test.slice',
        onExit: vi.fn(),
      });
    }).toThrowError();
  });
});

describe('sandbox opts', { repeats: 10 }, () => {
  let tempDirPath = '/inexistent/path/before';

  beforeEach(async () => {
    if (IS_DARWIN) {
      return;
    }
    tempDirPath = await mkdtemp(join(tmpdir(), 'ruspty-'));
  });

  afterEach(async () => {
    if (IS_DARWIN) {
      return;
    }
    await rm(tempDirPath, { recursive: true });
    tempDirPath = '/inexistent/path/after';
  });

  testSkipOnDarwin('basic sandbox', async () => {
    const oldFds = getOpenFds();
    let buffer = '';
    const onExit = vi.fn();

    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', 'echo hello'],
      sandbox: {
        rules: [
          {
            operation: Operation.Modify,
            prefixes: [tempDirPath],
            message: 'Tried to modify a forbidden path',
          },
          {
            operation: Operation.Delete,
            prefixes: [tempDirPath],
            message: 'Tried to delete a forbidden path',
          },
        ],
      },
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer = data.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 0);
    expect(buffer).toContain('hello');
    expect(getOpenFds()).toStrictEqual(oldFds);
  });

  testSkipOnDarwin('basic protection against git-yeetage', async () => {
    const oldFds = getOpenFds();
    let buffer = '';
    const onExit = vi.fn();

    const gitPath = `${tempDirPath}/.git`;
    await mkdir(gitPath);
    const pty = new Pty({
      command: '/bin/sh',
      args: ['-c', `/bin/sh -c "rm -rf ${gitPath}"`],
      sandbox: {
        rules: [
          {
            operation: Operation.Delete,
            prefixes: [gitPath],
            message: 'Tried to delete a forbidden path',
          },
        ],
      },
      envs: process.env.PATH
        ? {
            PATH: process.env.PATH,
          }
        : {},
      onExit,
    });

    const readStream = pty.read;
    readStream.on('data', (data) => {
      buffer = data.toString();
    });

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledWith(null, 254);
    expect(buffer.trimEnd()).toBe(
      `Tried to delete a forbidden path: ${gitPath}`,
    );
    expect(getOpenFds()).toStrictEqual(oldFds);
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
