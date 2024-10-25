import { type Readable, Writable } from 'node:stream';
import { ReadStream } from 'node:tty';
import { Pty as RawPty, type Size } from './index.js';
import { type PtyOptions as RawOptions } from './index.js';

export type PtyOptions = RawOptions;

type ExitResult = {
  error: NodeJS.ErrnoException | null;
  code: number;
};

export class Pty {
  #pty: RawPty;
  #fd: number;
  #socket: ReadStream;
  #writable: Writable;
  #pendingExit: ExitResult | null = null;
  #ended = false;

  get read(): Readable {
    return this.#socket;
  }

  get write(): Writable {
    return this.#writable;
  }

  constructor(options: PtyOptions) {
    const realExit = options.onExit;

    // Create a proxy exit handler that coordinates with stream end
    const handleExit = (error: NodeJS.ErrnoException | null, code: number) => {
      const result = { error, code };
      if (this.#ended) {
        // Stream already ended, safe to call exit immediately
        realExit(error, code);
      } else {
        // Store exit result until stream ends
        this.#pendingExit = result;
      }
    };

    this.#pty = new RawPty({ ...options, onExit: handleExit });
    this.#fd = this.#pty.takeFd();

    this.#socket = new ReadStream(this.#fd);
    this.#writable = new Writable({
      write: this.#socket.write.bind(this.#socket),
    });

    // Handle stream end
    this.read.on('end', () => {
      this.#ended = true;
      if (this.#pendingExit) {
        // Process already exited, now safe to call exit callback
        const { error, code } = this.#pendingExit;
        realExit(error, code);
      }
    });

    // Filter expected PTY errors
    const handleError = (err: NodeJS.ErrnoException) => {
      if (err.code) {
        if (err.code === 'EINTR' || err.code === 'EAGAIN') {
          return;
        } else if (err.code.indexOf('EIO') !== -1) {
          this.read.off('error', handleError);
          this.#socket.emit('end');
          return;
        }
      }
      throw err;
    };

    this.read.on('error', handleError);
  }

  close() {
    // Use end() instead of destroy() to allow reading remaining data
    this.#socket.end();
  }

  resize(size: Size) {
    if (!this.#ended) {
      try {
        ptyResize(this.#fd, size);
      } catch (e: unknown) {
        if (e instanceof Error && 'code' in e && e.code === 'EBADF') {
          return;
        }
        throw e;
      }
    }
  }

  get pid() {
    return this.#pty.pid;
  }
}
