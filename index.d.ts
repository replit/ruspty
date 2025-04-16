/* tslint:disable */
/* eslint-disable */

/* auto-generated by NAPI-RS */

export const enum Operation {
  Modify = 'Modify',
  Delete = 'Delete',
}
/**
 * Sandboxing rules. Deleting / modifying a path with any of the prefixes is forbidden and will
 * cause process termination.
 */
export interface SandboxRule {
  /** The forbidden operation. */
  operation: Operation;
  /** The list of prefixes that are matched by this rule. */
  prefixes: Array<string>;
  /** The message to be shown if this rule triggers. */
  message: string;
}
/** Options for the sandbox. */
export interface SandboxOptions {
  rules: Array<SandboxRule>;
}
/** The options that can be passed to the constructor of Pty. */
export interface PtyOptions {
  command: string;
  args?: Array<string>;
  envs?: Record<string, string>;
  dir?: string;
  size?: Size;
  cgroupPath?: string;
  interactive?: boolean;
  sandbox?: SandboxOptions;
  onExit: (err: null | Error, exitCode: number) => void;
}
/** A size struct to pass to resize. */
export interface Size {
  cols: number;
  rows: number;
}
export const MAX_U16_VALUE: number;
export const MIN_U16_VALUE: number;
/** Resize the terminal. */
export declare function ptyResize(fd: number, size: Size): void;
/**
 * Set the close-on-exec flag on a file descriptor. This is `fcntl(fd, F_SETFD, FD_CLOEXEC)` under
 * the covers.
 */
export declare function setCloseOnExec(fd: number, closeOnExec: boolean): void;
/**
 * Get the close-on-exec flag on a file descriptor. This is `fcntl(fd, F_GETFD) & FD_CLOEXEC ==
 *_CLOEXEC` under the covers.
 */
export declare function getCloseOnExec(fd: number): boolean;
export declare class Pty {
  /** The pid of the forked process. */
  pid: number;
  constructor(opts: PtyOptions);
  /**
   * Transfers ownership of the file descriptor for the PTY controller. This can only be called
   * once (it will error the second time). The caller is responsible for closing the file
   * descriptor.
   */
  takeFd(): c_int;
}
