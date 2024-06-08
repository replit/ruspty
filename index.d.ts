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
}
/** A size struct to pass to resize. */
export interface Size {
  cols: number
  rows: number
}
export class Pty {
  /** The pid of the forked process. */
  pid: number
  constructor(opts: PtyOptions)
  /** Resize the terminal. */
  resize(size: Size): void
  /**
   * Returns a file descriptor for the PTY controller.
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
