/* tslint:disable */
/* eslint-disable */

/* auto-generated by NAPI-RS */

/** The options that can be passed to the constructor of Pty. */
export interface PtyOptions {
  command: string
  args?: Array<string>
  envs?: Record<string, string>
  dir?: string
  size?: Size
  onExit: (err: null | Error, exitCode: number) => void
  onData?: (err: null | Error, data: Buffer) => void
}
/** A size struct to pass to resize. */
export interface Size {
  cols: number
  rows: number
}
/**
 * A very thin wrapper around PTYs and processes. The caller is responsible for calling `.close()`
 * when all streams have been closed. We hold onto both ends of the PTY (controller and user) to
 * prevent reads from erroring out with EIO.
 *
 * This is the recommended usage:
 *
 * ```
 * const { Pty } = require('@replit/ruspy');
 * const fs = require('fs');
 *
 * const pty = new Pty({
 *   command: 'sh',
 *   args: [],
 *   envs: ENV,
 *   dir: CWD,
 *   size: { rows: 24, cols: 80 },
 *   onExit: (...result) => {
 *     pty.close();
 *     // TODO: Handle process exit.
 *   },
 * });
 *
 * const read = new fs.createReadStream('', {
 *   fd: pty.fd(),
 *   start: 0,
 *   highWaterMark: 16 * 1024,
 *   autoClose: true,
 * });
 * const write = new fs.createWriteStream('', {
 *   fd: pty.fd(),
 *   autoClose: true,
 * });
 *
 * read.on('data', (chunk) => {
 *   // TODO: Handle data.
 * });
 * read.on('error', (err) => {
 *   if (err.code && err.code.indexOf('EIO') !== -1) {
 *     // This is expected to happen when the process exits.
 *     return;
 *   }
 *   // TODO: Handle the error.
 * });
 * write.on('error', (err) => {
 *   if (err.code && err.code.indexOf('EIO') !== -1) {
 *     // This is expected to happen when the process exits.
 *     return;
 *   }
 *   // TODO: Handle the error.
 * });
 * ```
 */
export class Pty {
  /** The pid of the forked process. */
  pid: number
  constructor(opts: PtyOptions)
  /** Resize the terminal. */
  resize(size: Size): void
  /**
   * Returns a file descriptor for the PTY controller. If running under node, it will dup the file
   * descriptor, but under bun it will return the same file desciptor, since bun does not close
   * the streams by itself. Maybe that is a bug in bun, so we should confirm the new behavior
   * after we upgrade.
   *
   * See the docstring of the class for an usage example.
   */
  fd(): c_int
  /**
   * Close the PTY file descriptor. This must be called when the readers / writers of the PTY have
   * been closed, otherwise we will leak file descriptors!
   *
   * In an ideal world, this would be automatically called after the wait loop is done, but Node
   * doesn't like that one bit, since it implies that the file is closed outside of the main
   * event loop.
   */
  close(): void
}
