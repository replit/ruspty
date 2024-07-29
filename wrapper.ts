import { PassThrough, type Readable, type Writable } from 'node:stream';
import { ReadStream } from 'node:tty';
import {
  Pty as RawPty,
  type Size,
  setCloseOnExec as rawSetCloseOnExec,
  getCloseOnExec as rawGetCloseOnExec,
  ptyResize,
} from './index.js';
import { type PtyOptions as RawOptions } from './index.js';
import { initLogging as rawInitLogging } from './index.js';

export type PtyOptions = RawOptions;
export const initLogging = rawInitLogging;

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
  #socket: ReadStream;

  read: Readable;
  write: Writable;

  constructor(options: PtyOptions) {
    const realExit = options.onExit;

    let resolve: (value: ExitResult) => void;
    let exitResult: Promise<ExitResult> = new Promise((res) => {
      resolve = res;
    });
    const mockedExit = (error: NodeJS.ErrnoException | null, code: number) => {
      resolve({ error, code });
    };

    // when pty exits, we should wait until the fd actually ends (end OR error)
    // before closing the pty
    // we use a mocked exit function to capture the exit result
    // and then call the real exit function after the fd is fully read
    this.#pty = new RawPty({ ...options, onExit: mockedExit });
    // Transfer ownership of the FD to us.
    this.#fd = this.#pty.takeFd();

    this.#socket = new ReadStream(this.#fd);
    const userFacingRead = new PassThrough();
    const userFacingWrite = new PassThrough();
    this.#socket.pipe(userFacingRead);
    userFacingWrite.pipe(this.#socket);
    this.read = userFacingRead;
    this.write = userFacingWrite;

    // catch end events
    let handleCloseCalled = false;
    const handleClose = () => {
      if (handleCloseCalled) {
        return;
      }

      handleCloseCalled = true;
      exitResult.then((result) => realExit(result.error, result.code));
      userFacingRead.end();
    };
    this.#socket.on('close', handleClose);

    // PTYs signal their donness with an EIO error. we therefore need to filter them out (as well as
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
          // EIO only happens when the child dies . It is therefore our only true signal that there
          // is nothing left to read and we can start tearing things down. If we hadn't received an
          // error so far, we are considered to be in good standing.
          this.#socket.off('error', handleError);
          this.#socket.destroy();
          return;
        }
      }

      this.read.emit('error', err);
    };
    this.#socket.on('error', handleError);
  }

  close() {
    this.#socket.destroy();
  }

  resize(size: Size) {
    ptyResize(this.#fd, size);
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
