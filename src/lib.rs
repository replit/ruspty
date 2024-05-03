use libc::{self, c_int, TIOCSCTTY};
use napi::bindgen_prelude::JsFunction;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Error as NAPI_ERROR;
use napi::Status::GenericFailure;
use rustix_openpty::openpty;
use rustix_openpty::rustix::termios::Winsize;
use rustix_openpty::rustix::termios::{self, InputModes, OptionalActions};
use std::collections::HashMap;
use std::fs::File;
use std::io::Error;
use std::io::ErrorKind;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;

#[macro_use]
extern crate napi_derive;

#[napi]
#[allow(dead_code)]
struct Pty {
  file: File,
  #[napi(ts_type = "number")]
  pub fd: c_int,
  pub pid: u32,
}

#[napi(object)]
struct Size {
  pub cols: u16,
  pub rows: u16,
}

#[allow(dead_code)]
fn set_controlling_terminal(fd: c_int) -> Result<(), Error> {
  let res = unsafe {
    #[allow(clippy::cast_lossless)]
    libc::ioctl(fd, TIOCSCTTY as _, 0)
  };

  if res != 0 {
    return Err(Error::last_os_error());
  }

  Ok(())
}

#[allow(dead_code)]
fn set_nonblocking(fd: c_int) -> Result<(), NAPI_ERROR> {
  use libc::{fcntl, F_GETFL, F_SETFL, O_NONBLOCK};

  let status_flags = unsafe { fcntl(fd, F_GETFL, 0) };

  if status_flags < 0 {
    return Err(NAPI_ERROR::new(
      napi::Status::GenericFailure,
      format!("fcntl F_GETFL failed: {}", Error::last_os_error()),
    ));
  }

  let res = unsafe { fcntl(fd, F_SETFL, status_flags | O_NONBLOCK) };

  if res != 0 {
    return Err(NAPI_ERROR::new(
      napi::Status::GenericFailure,
      format!("fcntl F_SETFL failed: {}", Error::last_os_error()),
    ));
  }

  Ok(())
}

#[napi]
impl Pty {
  #[napi(constructor)]
  #[allow(dead_code)]
  pub fn new(
    command: String,
    args: Vec<String>,
    envs: HashMap<String, String>,
    dir: String,
    size: Size,
    #[napi(ts_arg_type = "(err: null | Error, exitCode: number) => void")] on_exit: JsFunction,
  ) -> Result<Self, NAPI_ERROR> {
    let window_size = Winsize {
      ws_col: size.cols,
      ws_row: size.rows,
      ws_xpixel: 0,
      ws_ypixel: 0,
    };

    let mut cmd = Command::new(command);
    cmd.args(args);

    let pty_pair = openpty(None, Some(&window_size))
      .map_err(|err| NAPI_ERROR::new(napi::Status::GenericFailure, err))?;

    let fd_controller = pty_pair.controller.as_raw_fd();
    let fd_user = pty_pair.user.as_raw_fd();

    if let Ok(mut termios) = termios::tcgetattr(&pty_pair.controller) {
      termios.input_modes.set(InputModes::IUTF8, true);
      termios::tcsetattr(&pty_pair.controller, OptionalActions::Now, &termios)
        .map_err(|err| NAPI_ERROR::new(napi::Status::GenericFailure, err))?;
    }

    cmd.stdin(unsafe { Stdio::from_raw_fd(fd_controller) });
    cmd.stderr(unsafe { Stdio::from_raw_fd(fd_controller) });
    cmd.stdout(unsafe { Stdio::from_raw_fd(fd_controller) });

    cmd.envs(envs);
    cmd.current_dir(dir);

    unsafe {
      cmd.pre_exec(move || {
        let err = libc::setsid();
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "Failed to set session id"));
        }

        set_controlling_terminal(0)?;

        libc::close(fd_user);
        libc::close(fd_controller);

        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
        libc::signal(libc::SIGHUP, libc::SIG_DFL);
        libc::signal(libc::SIGINT, libc::SIG_DFL);
        libc::signal(libc::SIGQUIT, libc::SIG_DFL);
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        libc::signal(libc::SIGALRM, libc::SIG_DFL);

        Ok(())
      });
    }

    let ts_on_exit: ThreadsafeFunction<i32, ErrorStrategy::CalleeHandled> = on_exit
      .create_threadsafe_function(0, |ctx| ctx.env.create_int32(ctx.value).map(|v| vec![v]))?;

    let mut child = cmd
      .spawn()
      .map_err(|err| NAPI_ERROR::new(GenericFailure, err))?;

    let pid = child.id();

    // Now that we have opened the child, we can move the FD into a File.
    let file = File::from(pty_pair.user);
    let fd = file.as_raw_fd();
    drop(pty_pair.controller);

    // We're creating a new thread for every child, this uses a bit more system resources compared
    // to alternatives (below), trading off simplicity of implementation.
    //
    // The alternatives:
    // - Mandate that every single `wait` goes through a central process-wide loop that knows
    //   about all processes (this is what `pid1` does), but needs a bit of care and some static
    //   analysis to ensure that every single call goes through the wrapper to avoid double `wait`'s
    //   on a child.
    // - Have a single thread loop where other entities can register children (by sending the pid
    //   over a channel) and this loop can use `epoll` to listen for each child's `pidfd` for when
    //   they are ready to be `wait`'ed. This has the inconvenience that it consumes one FD per child.
    //
    // For discussion check out: https://github.com/replit/ruspty/pull/1#discussion_r1463672548
    thread::spawn(move || {
      match child.wait() {
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
            Err(NAPI_ERROR::new(
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

      // Close the fd once we return from `child.wait()`.
      unsafe {
        rustix::io::close(fd);
      }
    });

    Ok(Pty { file, fd, pid })
  }

  #[napi]
  #[allow(dead_code)]
  pub fn resize(&mut self, size: Size) -> Result<(), NAPI_ERROR> {
    let window_size = Winsize {
      ws_col: size.cols,
      ws_row: size.rows,
      ws_xpixel: 0,
      ws_ypixel: 0,
    };

    let res = unsafe { libc::ioctl(self.fd, libc::TIOCSWINSZ, &window_size as *const _) };

    if res != 0 {
      return Err(NAPI_ERROR::new(
        napi::Status::GenericFailure,
        format!("ioctl TIOCSWINSZ failed: {}", Error::last_os_error()),
      ));
    }

    Ok(())
  }
}
