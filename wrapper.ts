import { PassThrough, type Readable, type Writable } from 'node:stream';
import { read } from 'node:fs';
import { EventEmitter } from 'node:events';
import { ReadStream } from 'node:tty';
import { join, resolve, dirname } from 'node:path';
import {
  Pty as RawPty,
  type Size,
  setCloseOnExec as rawSetCloseOnExec,
  getCloseOnExec as rawGetCloseOnExec,
  type PtyOptions as RawOptions,
  ptyResize,
  Inotify,
  IN_DELETE,
  IN_IGNORED,
  IN_Q_OVERFLOW,
} from './index.js';

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

    // PTYs signal their doneness with an EIO error. we therefore need to filter them out (as well as
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

type WatchedDir = {
  path: string;
  descriptor: number;
};

/**
 * A way to access Linux' `inotify(7)` subsystem. For simplicity, this only allows subscribing for
 * events on files (these files may not exist upfront) and only for modify-close and rename-to
 * events (which should cover atomic writes). As opposed to fs.watch / chokidar, this only considers
 * when a file is done being modified, and does not track any other states (like creation or partial
 * modification). This function will throw if we could not register watchers for all provided paths.
 * Any error that occurs while reading events will be provided via the error callback. Once an error
 * is provided, no further events will occur.
 *
 * The provided callback will be invoked with the path of the file (one of the paths provided, it
 * will not be canonicalized or resolved), and the kind of event ('modify' or 'delete' only). The
 * 'overflow' kind will be sent without a path if the queue overflowed.
 *
 * In order to reliably track files that may not exist and atomic writes, instead of installing a
 * watch on all of the specified paths, we will install a watch on the directories where the files
 * are. This has two implications:
 * * The directories must exist when this function is invoked.
 * * If the directories are renamed, this function will stop being able to track the files.
 *
 * These two constraints are acceptable for most (not all) of Replit's pid2 requirements. Notably,
 * the LSP server needs to be able to register / unregister directories recursively.
 *
 * Returns an async function that closes the watcher. It will return once there are no more events
 * in the queue.
 */
export function watch({
  paths,
  eventCallback,
  errorCallback,
}: {
  paths: Array<string>;
  eventCallback: (event: {
    path: string;
    kind: 'modify' | 'delete' | 'overflow';
  }) => void | Promise<void>;
  errorCallback?: (err: NodeJS.ErrnoException) => void;
}): () => Promise<void> {
  const inotify = new Inotify();
  const watchedPaths = new Map<string, string>();
  const watchedDirs = new Map<string, WatchedDir>();
  const watchedDescriptors = new Map<number, WatchedDir>();
  const listener = new EventEmitter();

  try {
    for (const path of paths) {
      const resolvedPath = resolve(path);
      watchedPaths.set(resolvedPath, path);
      const dir = dirname(resolvedPath);
      let watchedDir = watchedDirs.get(dir);
      if (watchedDir !== undefined) {
        continue;
      }
      watchedDir = {
        path: dir,
        descriptor: inotify.addCloseWrite(dir),
      };
      watchedDirs.set(dir, watchedDir);
      watchedDescriptors.set(watchedDir.descriptor, watchedDir);
    }
  } catch (err: unknown) {
    inotify.close();
    throw err;
  }

  listener.on('event', eventCallback);
  if (errorCallback) {
    listener.on('error', errorCallback);
  }

  // createReadStream, as opposed to TTY's new ReadStream, does not like the file descriptor not
  // being owned by Node to begin with. As such, we'll let Rust keep the ownership of the FD and
  // will use the callback APIs to read from it.
  const fd = inotify.fd();
  let closed = false;
  let buf = Buffer.alloc(4096);
  let bufOffset = 0;
  let drainedAccept: () => void;
  const drainedPromise = new Promise<void>((accept) => {
    drainedAccept = accept;
  });
  const dispose = async () => {
    if (closed) {
      return;
    }
    closed = true;
    inotify.close();
    // Normally after closing the file descriptor, we _might_ get one more callback, but it's not
    // guaranteed. To avoid waiting forever, we will only wait a little bit for that. Node 20+ uses
    // libuv and it uses io_uring under the covers, so we won't have a situation where we are
    // bamboozled into reading the fd after it being closed.
    await Promise.race([
      drainedPromise,
      new Promise((accept) => setTimeout(accept, 25)),
    ]);
    listener.removeAllListeners('event');
    listener.removeAllListeners('error');
  };
  const fdCallback = (err: NodeJS.ErrnoException | null, bytesRead: number) => {
    if (err) {
      if (closed) {
        drainedAccept();
      } else {
        const code = err.code;
        if (code === 'EINTR' || code === 'EAGAIN') {
          // these two are expected. EINTR happens when the kernel restarts a `read(2)`/`write(2)`
          // syscall due to it being interrupted by another syscall, and EAGAIN happens when there
          // is no more data to be read by the fd.
          bufOffset += bytesRead;
          read(fd, buf, bufOffset, buf.byteLength - bufOffset, -1, fdCallback);
        } else {
          // No more events will flow.
          listener.emit('error', err);
          drainedAccept();
          dispose();
        }
      }
      return;
    }

    // Parse the content of the read buffer. The format is specified in
    // https://man7.org/linux/man-pages/man7/inotify.7.html
    let chunk = buf.subarray(0, bytesRead);
    while (chunk.length >= 16) {
      // This code only runs in Little-Endian processors. x86_64 and armv8 are covered, fortunately.
      const wd = chunk.readUint32LE(0);
      const mask = chunk.readUint32LE(4);
      // We skip the cookie since we do not use it.
      const len = chunk.readUint32LE(12);
      if (len > 2048) {
        // The maximum length of a filename in Linux is 255, as seen in
        // linux/include/uapi/linux/limits.h. But we don't have a guarantee that it won't change in
        // the future, so we'll cap that at 2k. If that is exceeded, we _definitely_ did something
        // wrong and are no longer reading valid events.
        listener.emit(
          'error',
          new Error(`inotify event invalid length: ${len}`),
        );
        drainedAccept();
        dispose();
        return;
      }
      if (chunk.length < 16 + len) {
        // Oh no, we read a fragmented message. This should never happen normally, but we'll be
        // robust and keep trying.
        break;
      }
      // The name is always NUL-terminated. The kernel can optionally add extra NUL characters at
      // the end to align the next message to a nice address boundary (typically 4 or 8 bytes,
      // depending on the processor).
      const name = chunk
        .subarray(16, 16 + len)
        .toString('utf8')
        .replaceAll('\x00', '');
      // Advance the pointer to the next event.
      chunk = chunk.subarray(16 + len);

      if ((mask & IN_Q_OVERFLOW) === IN_Q_OVERFLOW) {
        // Welp, we fell behind. We can't really pretend that everything changed because we don't
        // get to decide what the user will want to do with that information.
        listener.emit('event', { path: '', kind: 'overflow' });
        continue;
      }

      const watchedDir = watchedDescriptors.get(wd);
      if (watchedDir === undefined) {
        continue;
      }
      const path = join(watchedDir.path, name);
      const nonResolvedPath = watchedPaths.get(path);
      if (nonResolvedPath === undefined) {
        // Not interested in this path.
        continue;
      }
      // We're going to report closed-after-write and renames as modify. Some modifications will be
      // renames under the covers (like atomic writes).
      let kind = 'modify';
      if ((mask & (IN_DELETE | IN_IGNORED)) !== 0) {
        // IN_IGNORED is also emitted if the mount is gone.
        kind = 'delete';
      }
      listener.emit('event', { path: nonResolvedPath, kind });
    }

    if (closed) {
      drainedAccept();
      return;
    }

    // Reset the buffer and read one more event.
    if (chunk.length == 0) {
      // most common case: the buffer was fully used. we can start anew.
      bufOffset = 0;
    } else if (chunk.length == bytesRead) {
      // the chunk didn't even have a full entry there!
      bufOffset += bytesRead;
    } else {
      // awkward case, we didn't read a full entry, so we copy whatever was left and adjust the
      // offset.
      chunk.copy(buf);
      bufOffset = chunk.length;
    }
    read(fd, buf, bufOffset, buf.byteLength - bufOffset, -1, fdCallback);
  };
  read(fd, buf, bufOffset, buf.byteLength - bufOffset, -1, fdCallback);

  return dispose;
}
