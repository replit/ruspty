import type { Readable, Writable } from 'node:stream';
import { ReadStream } from 'node:tty';
import {
  Pty as RawPty,
  type Size,
  setCloseOnExec as rawSetCloseOnExec,
  getCloseOnExec as rawGetCloseOnExec,
  ptyResize,
} from './index.js';
import {
  type PtyOptions,
  Operation,
  type SandboxRule,
  type SandboxOptions,
} from './index.js';

export { Operation, type SandboxRule, type SandboxOptions, type PtyOptions };

type ExitResult = {
  error: NodeJS.ErrnoException | null;
  code: number;
};

/**
 * A very thin wrapper around PTYs and processes.
 *
 * @example
 * const { Pty } = require('@replit/ruspty');
 *
 * const pty = new Pty({
 *   command: '/bin/sh',
 *   args: [],
 *   envs: ENV,
 *   dir: CWD,
 *   size: { rows: 24, cols: 80 },
 *   onExit: (...result) => {
 *     // TODO: Handle process exit.
 *   },
 * });
 *
 * const read = pty.read;
 * const write = pty.write;
 *
 * read.on('data', (chunk) => {
 *   // TODO: Handle data.
 * });
 * write.write('echo hello\n');
 */
export class Pty {
  #pty: RawPty;
  #fd: number;

  #handledClose: boolean = false;
  #fdClosed: boolean = false;

  #socket: ReadStream;

  get read(): Readable {
    return this.#socket;
  }

  get write(): Writable {
    return this.#socket;
  }

  constructor(options: PtyOptions) {
    const realExit = options.onExit;

    let markExited!: (value: ExitResult) => void;
    let exitResult: Promise<ExitResult> = new Promise((resolve) => {
      markExited = resolve;
    });

    let markReadFinished!: () => void;
    let readFinished = new Promise<void>((resolve) => {
      markReadFinished = resolve;
    });
    const mockedExit = (error: NodeJS.ErrnoException | null, code: number) => {
      markExited({ error, code });
    };

    // when pty exits, we should wait until the fd actually ends (end OR error)
    // before closing the pty
    // we use a mocked exit function to capture the exit result
    // and then call the real exit function after the fd is fully read
    this.#pty = new RawPty({ ...options, onExit: mockedExit });
    // Transfer ownership of the FD to us.
    this.#fd = this.#pty.takeFd();

    this.#socket = new ReadStream(this.#fd);

    // catch end events
    const handleClose = async () => {
      if (this.#fdClosed) {
        return;
      }

      this.#fdClosed = true;

      // must wait for fd close and exit result before calling real exit
      await readFinished;
      const result = await exitResult;
      realExit(result.error, result.code);
    };

    this.read.once('end', markReadFinished);
    this.read.once('close', handleClose);

    // PTYs signal their done-ness with an EIO error. we therefore need to filter them out (as well as
    // cleaning up other spurious errors) so that the user doesn't need to handle them and be in
    // blissful peace.
    const handleError = (err: NodeJS.ErrnoException) => {
      if (err.code) {
        const code = err.code;
        if (code === 'EINTR' || code === 'EAGAIN') {
          // these two are expected. EINTR happens when the kernel restarts a `read(2)`/`write(2)`
          // syscall due to it being interrupted by another syscall, and EAGAIN happens when there
          // is no more data to be read by the fd.
          return;
        } else if (code.indexOf('EIO') !== -1) {
          // EIO only happens when the child dies. It is therefore our only true signal that there
          // is nothing left to read and we can start tearing things down. If we hadn't received an
          // error so far, we are considered to be in good standing.
          this.read.off('error', handleError);
          // emit 'end' to signal no more data
          // this will trigger our 'end' handler which marks readFinished
          this.read.emit('end');
          return;
        }
      }

      // if we haven't handled the error by now, we should throw it
      throw err;
    };

    this.read.on('error', handleError);
  }

  close() {
    this.#handledClose = true;

    // end instead of destroy so that the user can read the last bits of data
    // and allow graceful close event to mark the fd as ended
    this.#socket.end();
  }

  resize(size: Size) {
    if (this.#handledClose || this.#fdClosed) {
      return;
    }

    try {
      ptyResize(this.#fd, size);
    } catch (e: unknown) {
      // napi-rs only throws strings so we must string match here
      // https://docs.rs/napi/latest/napi/struct.Error.html#method.new
      if (
        e instanceof Error &&
        (e.message.indexOf('os error 9') !== -1 || // EBADF
          e.message.indexOf('os error 25') !== -1)
      ) {
        // ENOTTY
        // error 9 is EBADF (bad file descriptor)
        // error 25 is ENOTTY (inappropriate ioctl for device)
        // These can happen if the PTY has already exited or wasn't a terminal device
        // In that case, we just ignore the error.
        return;
      }

      // otherwise, rethrow
      throw e;
    }
  }

  get pid() {
    return this.#pty.pid;
  }
}

/**
 * Set the close-on-exec flag on a file descriptor. This is `fcntl(fd, F_SETFD, FD_CLOEXEC)` under
 * the covers.
 */
export const setCloseOnExec = rawSetCloseOnExec;

/**
 * Get the close-on-exec flag on a file descriptor. This is `fcntl(fd, F_GETFD) & FD_CLOEXEC ==
 * FD_CLOEXEC` under the covers.
 */
export const getCloseOnExec = rawGetCloseOnExec;
