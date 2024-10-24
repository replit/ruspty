import { type Readable, type Writable } from 'node:stream';
import { ReadStream, WriteStream } from 'node:tty';
import {
  Pty as RawPty,
  type Size,
  setCloseOnExec as rawSetCloseOnExec,
  getCloseOnExec as rawGetCloseOnExec,
  ptyResize,
} from './index.js';
import { type PtyOptions as RawOptions } from './index.js';

export type PtyOptions = RawOptions;

type ExitResult = {
  error: NodeJS.ErrnoException | null;
  code: number;
};

/**
 * A very thin wrapper around PTYs and processes.
 *
 * @example
 * const { Pty } = require('@replit/ruspty');
 * const fs = require('fs');
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
  #fdEnded: boolean = false;

  read: Readable;
  write: Writable;

  constructor(options: PtyOptions) {
    const realExit = options.onExit;

    let markExited: (value: ExitResult) => void;
    let exitResult: Promise<ExitResult> = new Promise((resolve) => {
      markExited = resolve;
    });
    let markFdClosed: () => void;
    let fdClosed = new Promise<void>((resolve) => {
      markFdClosed = resolve;
    });
    const mockedExit = (error: NodeJS.ErrnoException | null, code: number) => {
      console.log('mocked exit')
      markExited({ error, code });
    };

    // when pty exits, we should wait until the fd actually ends (end OR error)
    // before closing the pty
    // we use a mocked exit function to capture the exit result
    // and then call the real exit function after the fd is fully read
    this.#pty = new RawPty({ ...options, onExit: mockedExit });
    // Transfer ownership of the FD to us.
    this.#fd = this.#pty.takeFd();

    this.read = new ReadStream(this.#fd);
    this.write = new WriteStream(this.#fd);

    // catch end events
    const handleEnd = async () => {
      if (this.#fdEnded) {
        return;
      }

      this.#fdEnded = true;

      // must wait for fd close and exit result before calling real exit
      await fdClosed;
      const result = await exitResult;
      console.log('calling real exit')
      realExit(result.error, result.code)
    }

    this.read.on('end', handleEnd);
    this.read.on('close', () => {
      markFdClosed();
    });

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
        }
        if (code.indexOf('EIO') !== -1) {
          // EIO only happens when the child dies. It is therefore our only true signal that there
          // is nothing left to read and we can start tearing things down. If we hadn't received an
          // error so far, we are considered to be in good standing.
          console.log('eio')
          this.read.off('error', handleError);
          markFdClosed();
          return;
        }
      }
    };

    this.read.on('error', handleError);
  }

  close() {
    // end instead of destroy so that the user can read the last bits of data
    // and allow graceful close event to mark the fd as ended
    this.write.end();
  }

  resize(size: Size) {
    if (this.#fdEnded) {
      return;
    }

    try {
      ptyResize(this.#fd, size);
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && e.code === 'EBADF') {
        // EBADF means the file descriptor is invalid. This can happen if the PTY has already
        // exited but we don't know about it yet. In that case, we just ignore the error.
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
