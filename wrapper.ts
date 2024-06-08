import { PassThrough, Readable, Writable } from 'stream';
import { Pty as RawPty, type Size } from './index.js';
import { type PtyOptions as RawOptions } from './index.js';
import fs from 'fs';

export type PtyOptions = RawOptions;

type ExitResult = {
  error: NodeJS.ErrnoException | null;
  code: number;
}

/**
 * A very thin wrapper around PTYs and processes. The caller is responsible for calling `.close()`
 * when all streams have been closed. We hold onto both ends of the PTY (controller and user) to
 * prevent reads from erroring out with EIO.
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

  read: Readable;
  write: Writable;

  constructor(options: PtyOptions) {
    const realExit = options.onExit;

    let resolve: (value: ExitResult) => void;
    let exitResult: Promise<ExitResult> = new Promise((res) => {
      resolve = res;
    })
    const mockedExit = (error: NodeJS.ErrnoException | null, code: number) => {
      resolve({ error, code });
    }

    // when pty exits, we should wait until the fd actually ends (end OR error)
    // before closing the pty
    // we use a mocked exit function to capture the exit result 
    // and then call the real exit function after the fd is fully read
    this.#pty = new RawPty({ ...options, onExit: mockedExit });
    const fd = this.#pty.fd();

    const read = fs.createReadStream('', { fd, autoClose: false });
    const write = fs.createWriteStream('', { fd, autoClose: false });
    const userFacingRead = new PassThrough();
    const userFacingWrite = new PassThrough();
    read.pipe(userFacingRead);
    userFacingWrite.pipe(write);
    this.read = userFacingRead;
    this.write = userFacingWrite;

    let eofCalled = false;
    const eof = () => {
      if (eofCalled) {
        return;
      }

      eofCalled = true;
      exitResult.then((result) => realExit(result.error, result.code));
      this.#pty.close();
      userFacingRead.end();
    }

    // catch end events
    read.on('end', eof)

    // strip out EIO errors
    read.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        eof();
        return;
      }

      this.read.emit('error', err);
    });

    write.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code && err.code.indexOf('EIO') !== -1) {
        eof();
        return;
      }

      this.write.emit('error', err);
    });
  }

  close() {
    this.#pty.close();
  }

  resize(size: Size) {
    this.#pty.resize(size);
  }
}
