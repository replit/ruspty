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
unsafe fn set_nonblocking(fd: c_int) -> Result<(), NAPI_ERROR> {
  use libc::{fcntl, F_GETFL, F_SETFL, O_NONBLOCK};

  let res = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);

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
    #[napi(ts_arg_type = "[cols: number, rows: number]")] size: (u16, u16),
    #[napi(ts_arg_type = "(err: null | Error, exitCode: number) => void")] on_exit: JsFunction,
  ) -> Result<Self, NAPI_ERROR> {
    let window_size = Winsize {
      ws_col: size.0,
      ws_row: size.1,
      ws_xpixel: 0,
      ws_ypixel: 0,
    };

    let mut cmd = Command::new(command);
    cmd.args(args);

    let ends = match openpty(None, Some(&window_size)) {
      Ok(ends) => ends,
      Err(err) => return Err(NAPI_ERROR::new(napi::Status::GenericFailure, err)),
    };

    let fd_controller = ends.controller.as_raw_fd();
    let fd_user = ends.user.as_raw_fd();

    if let Ok(mut termios) = termios::tcgetattr(&ends.controller) {
      termios.input_modes.set(InputModes::IUTF8, true);
      let _ = termios::tcsetattr(&ends.controller, OptionalActions::Now, &termios);
    }

    cmd.stdin(unsafe { Stdio::from_raw_fd(fd_user) });
    cmd.stderr(unsafe { Stdio::from_raw_fd(fd_user) });
    cmd.stdout(unsafe { Stdio::from_raw_fd(fd_user) });

    cmd.envs(envs);
    cmd.current_dir(dir);

    unsafe {
      cmd.pre_exec(move || {
        let err = libc::setsid();
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "Failed to set session id"));
        }

        match set_controlling_terminal(fd_user) {
          Ok(_) => {}
          Err(err) => return Err(err),
        };

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
      .create_threadsafe_function(0, |ctx| ctx.env.create_int32(ctx.value).map(|v| vec![v]))
      .unwrap();

    let mut child = match cmd.spawn() {
      Ok(child) => child,
      Err(err) => {
        return Err(NAPI_ERROR::new(GenericFailure, err));
      }
    };

    let pid = child.id();

    thread::spawn(move || match child.wait() {
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
    });

    unsafe {
      match set_nonblocking(fd_controller) {
        Ok(_) => {}
        Err(err) => return Err(err),
      };
    }

    let file = File::from(ends.controller);
    let fd = file.as_raw_fd();

    Ok(Pty { file, fd, pid })
  }

  #[napi]
  #[allow(dead_code)]
  pub fn resize(
    &mut self,
    #[napi(ts_arg_type = "[cols: number, rows: number]")] size: (u16, u16),
  ) -> Result<(), NAPI_ERROR> {
    let window_size = Winsize {
      ws_col: size.0,
      ws_row: size.1,
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
