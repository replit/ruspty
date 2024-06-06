use libc::{self, c_int};
use napi::bindgen_prelude::JsFunction;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status::GenericFailure;
use napi::{self, Env};
use nix::errno::Errno;
use nix::pty::{openpty, Winsize};
use nix::sys::termios::{self, SetArg};
use std::collections::HashMap;
use std::io::Error;
use std::io::ErrorKind;
use std::os::fd::FromRawFd;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;

#[macro_use]
extern crate napi_derive;

/// A very thin wrapper around PTYs and processes. The caller is responsible for calling `.close()`
/// when all streams have been closed. We hold onto both ends of the PTY (controller and user) to
/// prevent reads from erroring out with EIO.
///
/// This is the recommended usage:
///
/// ```
/// const { Pty } = require('@replit/ruspty');
/// const fs = require('fs');
///
/// const pty = new Pty({
///   command: 'sh',
///   args: [],
///   envs: ENV,
///   dir: CWD,
///   size: { rows: 24, cols: 80 },
///   onExit: (...result) => {
///     pty.close();
///     // TODO: Handle process exit.
///   },
/// });
///
/// const read = new fs.createReadStream('', {
///   fd: pty.fd(),
///   highWaterMark: 16 * 1024,
///   autoClose: false,
/// });
/// const write = new fs.createWriteStream('', {
///   fd: pty.fd(),
///   autoClose: false,
/// });
///
/// read.on('data', (chunk) => {
///   // TODO: Handle data.
/// });
/// read.on('error', (err) => {
///   if (err.code && err.code.indexOf('EIO') !== -1) {
///     // This is expected to happen when the process exits.
///     return;
///   }
///   // TODO: Handle the error.
/// });
/// write.on('error', (err) => {
///   if (err.code && err.code.indexOf('EIO') !== -1) {
///     // This is expected to happen when the process exits.
///     return;
///   }
///   // TODO: Handle the error.
/// });
/// ```
#[napi]
#[allow(dead_code)]
struct Pty {
  controller_fd: Option<OwnedFd>,
  user_fd: Option<OwnedFd>,
  /// The pid of the forked process.
  pub pid: u32,
}

/// The options that can be passed to the constructor of Pty.
#[napi(object)]
struct PtyOptions {
  pub command: String,
  pub args: Option<Vec<String>>,
  pub envs: Option<HashMap<String, String>>,
  pub dir: Option<String>,
  pub size: Option<Size>,
  #[napi(ts_type = "(err: null | Error, exitCode: number) => void")]
  pub on_exit: JsFunction,
}

/// A size struct to pass to resize.
#[napi(object)]
struct Size {
  pub cols: u16,
  pub rows: u16,
}

fn cast_to_napi_error(err: Errno) -> napi::Error {
  napi::Error::new(GenericFailure, err)
}

#[napi]
impl Pty {
  #[napi(constructor)]
  #[allow(dead_code)]
  pub fn new(_env: Env, opts: PtyOptions) -> Result<Self, napi::Error> {
    let size = opts.size.unwrap_or(Size { cols: 80, rows: 24 });
    let window_size = Winsize {
      ws_col: size.cols,
      ws_row: size.rows,
      ws_xpixel: 0,
      ws_ypixel: 0,
    };

    let mut cmd = Command::new(opts.command);
    if let Some(args) = opts.args {
      cmd.args(args);
    }

    // open pty pair
    let pty_res = openpty(&window_size, None).map_err(cast_to_napi_error)?;
    let controller_fd = pty_res.master;
    let user_fd = pty_res.slave;

    // duplicate pty user_fd to be the child's stdin, stdout, and stderr
    cmd.stdin(Stdio::from(user_fd.try_clone()?));
    cmd.stderr(Stdio::from(user_fd.try_clone()?));
    cmd.stdout(Stdio::from(user_fd.try_clone()?));

    // we want the env to be clean, we can always pass in `process.env` if we want to.
    cmd.env_clear();
    if let Some(envs) = opts.envs {
      cmd.envs(envs);
    }

    // set working dir if applicable
    if let Some(dir) = opts.dir {
      cmd.current_dir(dir);
    }

    unsafe {
      let raw_user_fd = user_fd.as_raw_fd();
      let raw_controller_fd = controller_fd.as_raw_fd();

      // right before we spawn the child, we should do a bunch of setup
      // this is all run in the context of the child process
      cmd.pre_exec(move || {
        // start a new session
        let err = libc::setsid();
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "setsid"));
        }

        // become the controlling tty for the program
        let err = libc::ioctl(raw_user_fd, libc::TIOCSCTTY.into(), 0);
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "ioctl-TIOCSCTTY"));
        }

        // we need to drop the controller fd, since we don't need it in the child
        // and it's not safe to keep it open
        libc::close(raw_controller_fd);

        // set input modes
        let user_fd = OwnedFd::from_raw_fd(raw_user_fd);
        if let Ok(mut termios) = termios::tcgetattr(&user_fd) {
          termios.input_flags |= termios::InputFlags::IUTF8;
          termios::tcsetattr(&user_fd, SetArg::TCSANOW, &termios)?;
        }

        // reset signal handlers
        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
        libc::signal(libc::SIGHUP, libc::SIG_DFL);
        libc::signal(libc::SIGINT, libc::SIG_DFL);
        libc::signal(libc::SIGQUIT, libc::SIG_DFL);
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        libc::signal(libc::SIGALRM, libc::SIG_DFL);

        Ok(())
      });
    }

    // actually spawn the child
    let mut child = cmd.spawn()?;
    let pid = child.id();

    // We're creating a new thread for every child, this uses a bit more system resources compared
    // to alternatives (below), trading off simplicity of implementation.
    //
    // The alternatives:
    // - Mandate that every single `wait` goes through a central process-wide loop that knows
    //   about all processes (this is what `pid1` does), but needs a bit of care and some static
    //   analysis to ensure that every single call goes through the wrapper to avoid double `wait`'s
    //   on a child.
    // - Have a single thread loop where other entities can register children (by sending the pid
    //   over a channel) and this loop can use `poll` to listen for each child's `pidfd` for when
    //   they are ready to be `wait`'ed. This has the inconvenience that it consumes one FD per child.
    //
    // For discussion check out: https://github.com/replit/ruspty/pull/1#discussion_r1463672548
    let ts_on_exit: ThreadsafeFunction<i32, ErrorStrategy::CalleeHandled> = opts
      .on_exit
      .create_threadsafe_function(0, |ctx| ctx.env.create_int32(ctx.value).map(|v| vec![v]))?;

    thread::spawn(move || {
      let wait_result = child.wait();

      // we don't drop fds immediately
      // let pty.close() be responsible for closing them

      match wait_result {
        Ok(status) => {
          if status.success() {
            ts_on_exit.call(Ok(0), ThreadsafeFunctionCallMode::Blocking);
          } else {
            ts_on_exit.call(
              Ok(status.code().unwrap_or(-1)),
              ThreadsafeFunctionCallMode::Blocking,
            );
          }
        }
        Err(err) => {
          ts_on_exit.call(
            Err(napi::Error::new(
              GenericFailure,
              format!(
                "OS error when waiting for child process to exit: {}",
                err.raw_os_error().unwrap_or(-1)
              ),
            )),
            ThreadsafeFunctionCallMode::Blocking,
          );
        }
      }
    });

    Ok(Pty {
      controller_fd: Some(controller_fd),
      user_fd: Some(user_fd),
      pid,
    })
  }

  /// Resize the terminal.
  #[napi]
  #[allow(dead_code)]
  pub fn resize(&mut self, size: Size) -> Result<(), napi::Error> {
    let window_size = Winsize {
      ws_col: size.cols,
      ws_row: size.rows,
      ws_xpixel: 0,
      ws_ypixel: 0,
    };

    if let Some(fd) = &self.controller_fd {
      let res = unsafe { libc::ioctl(fd.as_raw_fd(), libc::TIOCSWINSZ, &window_size as *const _) };
      if res == -1 {
        return Err(napi::Error::new(
          napi::Status::GenericFailure,
          format!("ioctl TIOCSWINSZ failed: {}", Error::last_os_error()),
        ));
      }

      Ok(())
    } else {
      Err(napi::Error::new(
        napi::Status::GenericFailure,
        "ioctl TIOCSWINSZ failed: bad file descriptor (os error 9)",
      ))
    }
  }

  /// Returns a file descriptor for the PTY controller.
  /// See the docstring of the class for an usage example.
  #[napi]
  #[allow(dead_code)]
  pub fn fd(&mut self) -> Result<c_int, napi::Error> {
    if let Some(fd) = &self.controller_fd {
      Ok(fd.as_raw_fd())
    } else {
      Err(napi::Error::new(
        napi::Status::GenericFailure,
        "fcntl F_DUPFD_CLOEXEC failed: bad file descriptor (os error 9)",
      ))
    }
  }

  /// Close the PTY file descriptor. This must be called when the readers / writers of the PTY have
  /// been closed, otherwise we will leak file descriptors!
  ///
  /// In an ideal world, this would be automatically called after the wait loop is done, but Node
  /// doesn't like that one bit, since it implies that the file is closed outside of the main
  /// event loop.
  #[napi]
  #[allow(dead_code)]
  pub fn close(&mut self) -> Result<(), napi::Error> {
    if let Some(fd) = self.controller_fd.take() {
      unsafe {
        if libc::close(fd.as_raw_fd()) == -1 {
          return Err(napi::Error::new(
            napi::Status::GenericFailure,
            format!("close failed: {}", Error::last_os_error()),
          ));
        }
      };
    }

    if let Some(fd) = self.user_fd.take() {
      unsafe {
        if libc::close(fd.as_raw_fd()) == -1 {
          return Err(napi::Error::new(
            napi::Status::GenericFailure,
            format!("close failed: {}", Error::last_os_error()),
          ));
        }
      };
    }

    Ok(())
  }
}
