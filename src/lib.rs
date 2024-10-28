use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::io::Error;
use std::io::ErrorKind;
use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::fd::{BorrowedFd, FromRawFd, IntoRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use backoff::backoff::Backoff;
use backoff::ExponentialBackoffBuilder;
use libc::{self, c_int};
use napi::bindgen_prelude::JsFunction;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status::GenericFailure;
use napi::{self, Env};
use nix::errno::Errno;
use nix::fcntl::{fcntl, FcntlArg, FdFlag, OFlag};
use nix::libc::{FIONREAD, TIOCOUTQ, ioctl};
use nix::pty::{openpty, Winsize};
use nix::sys::termios::{self, SetArg};

#[macro_use]
extern crate napi_derive;

#[napi]
#[allow(dead_code)]
struct Pty {
  controller_fd: Option<OwnedFd>,
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
  pub cgroup_path: Option<String>,
  pub interactive: Option<bool>,
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

// if the child process exits before the controller fd is fully read or the user fd is fully
// flushed, we might accidentally end in a case where onExit is called but js hasn't had
// the chance to fully read the controller fd
// let's wait until the controller fd is fully read before we call onExit
fn poll_pty_fds_until_read(controller_fd: RawFd, user_fd: RawFd) {
  let mut backoff = ExponentialBackoffBuilder::default()
    .with_initial_interval(Duration::from_millis(1))
    .with_max_interval(Duration::from_millis(100))
    .with_max_elapsed_time(Some(Duration::from_secs(1)))
    .build();

  loop {
    // check both input and output queues for both FDs
    let mut controller_inq: i32 = 0;
    let mut controller_outq: i32 = 0;
    let mut user_inq: i32 = 0;
    let mut user_outq: i32 = 0;

    // safe because we're passing valid file descriptors and properly sized integers
    unsafe {
      // check bytes waiting to be read (FIONREAD, equivalent to TIOCINQ on Linux)
      if ioctl(controller_fd, FIONREAD, &mut controller_inq) == -1
        || ioctl(user_fd, FIONREAD, &mut user_inq) == -1
      {
        // break if we can't read
        break;
      }

      // check bytes waiting to be written (TIOCOUTQ)
      if ioctl(controller_fd, TIOCOUTQ, &mut controller_outq) == -1
        || ioctl(user_fd, TIOCOUTQ, &mut user_outq) == -1
      {
        // break if we can't read
        break;
      }
    }

    // if all queues are empty, we're done
    if controller_inq == 0 && controller_outq == 0 && user_inq == 0 && user_outq == 0 {
      break;
    }

    // apply backoff strategy
    if let Some(d) = backoff.next_backoff() {
      thread::sleep(d);
      continue;
    } else {
      // we have exhausted our attempts
      break;
    }
  }
}

#[napi]
impl Pty {
  #[napi(constructor)]
  #[allow(dead_code)]
  pub fn new(_env: Env, opts: PtyOptions) -> Result<Self, napi::Error> {
    #[cfg(not(target_os = "linux"))]
    if opts.cgroup_path.is_some() {
      return Err(napi::Error::new(
        napi::Status::GenericFailure,
        "cgroup_path is only supported on Linux",
      ));
    }

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

    // open pty pair, and set close-on-exec to avoid unwanted copies of the FDs from finding their
    // way into subprocesses. Also set the nonblocking flag to avoid Node from consuming a full I/O
    // thread for this.
    let pty_res = openpty(&window_size, None).map_err(cast_to_napi_error)?;
    let controller_fd = pty_res.master;
    let user_fd = pty_res.slave;
    set_close_on_exec(controller_fd.as_raw_fd(), true)?;
    set_close_on_exec(user_fd.as_raw_fd(), true)?;
    set_nonblocking(controller_fd.as_raw_fd())?;

    // duplicate pty user_fd to be the child's stdin, stdout, and stderr
    if opts.interactive.unwrap_or(true) {
      cmd.stdin(Stdio::from(user_fd.try_clone()?));
    } else {
      cmd.stdin(Stdio::null());
    }
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

    let raw_user_fd = user_fd.as_raw_fd();
    let raw_controller_fd = controller_fd.as_raw_fd();
    unsafe {
      // right before we spawn the child, we should do a bunch of setup
      // this is all run in the context of the child process
      cmd.pre_exec(move || {
        // start a new session
        let err = libc::setsid();
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "setsid"));
        }

        // set the cgroup if specified
        #[cfg(target_os = "linux")]
        if let Some(cgroup_path) = &opts.cgroup_path {
          let pid = libc::getpid();
          let cgroup_path = format!("{}/cgroup.procs", cgroup_path);
          let mut cgroup_file = File::create(cgroup_path)?;
          cgroup_file.write_all(format!("{}", pid).as_bytes())?;
        }

        // become the controlling tty for the program
        let err = libc::ioctl(raw_user_fd, libc::TIOCSCTTY.into(), 0);
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "ioctl-TIOCSCTTY"));
        }

        // we need to drop the controller fd, since we don't need it in the child
        // and it's not safe to keep it open
        libc::close(raw_controller_fd);

        // just to be safe, mark every single file descriptor as close-on-exec.
        // needs to use the raw syscall to avoid dependencies on newer versions of glibc.
        #[cfg(target_os = "linux")]
        libc::syscall(
          libc::SYS_close_range,
          3,
          libc::c_uint::MAX,
          libc::CLOSE_RANGE_CLOEXEC as c_int,
        );

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

      // try to wait for the controller fd to be fully read
      poll_pty_fds_until_read(raw_controller_fd, raw_user_fd);
      drop(user_fd);

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
      pid,
    })
  }

  /// Transfers ownership of the file descriptor for the PTY controller. This can only be called
  /// once (it will error the second time). The caller is responsible for closing the file
  /// descriptor.
  #[napi]
  #[allow(dead_code)]
  pub fn take_fd(&mut self) -> Result<c_int, napi::Error> {
    if let Some(fd) = self.controller_fd.take() {
      Ok(fd.into_raw_fd())
    } else {
      Err(napi::Error::new(
        napi::Status::GenericFailure,
        "fd failed: bad file descriptor (os error 9)",
      ))
    }
  }
}

/// Resize the terminal.
#[napi]
#[allow(dead_code)]
fn pty_resize(fd: i32, size: Size) -> Result<(), napi::Error> {
  let window_size = Winsize {
    ws_col: size.cols,
    ws_row: size.rows,
    ws_xpixel: 0,
    ws_ypixel: 0,
  };

  let res = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &window_size as *const _) };
  if res == -1 {
    return Err(napi::Error::new(
      napi::Status::GenericFailure,
      format!("ioctl TIOCSWINSZ failed: {}", Error::last_os_error()),
    ));
  }

  Ok(())
}

/// Set the close-on-exec flag on a file descriptor. This is `fcntl(fd, F_SETFD, FD_CLOEXEC)` under
/// the covers.
#[napi]
#[allow(dead_code)]
fn set_close_on_exec(fd: i32, close_on_exec: bool) -> Result<(), napi::Error> {
  let old_flags = match fcntl(fd as RawFd, FcntlArg::F_GETFD) {
    Ok(flags) => FdFlag::from_bits_truncate(flags),
    Err(err) => {
      return Err(napi::Error::new(
        GenericFailure,
        format!("fcntl F_GETFD: {}", err,),
      ));
    }
  };
  let mut new_flags = old_flags;
  new_flags.set(FdFlag::FD_CLOEXEC, close_on_exec);
  if old_flags == new_flags {
    // It's already in the correct state!
    return Ok(());
  }

  if let Err(err) = fcntl(fd as RawFd, FcntlArg::F_SETFD(new_flags)) {
    return Err(napi::Error::new(
      GenericFailure,
      format!("fcntl F_SETFD: {}", err,),
    ));
  };

  Ok(())
}

/// Get the close-on-exec flag on a file descriptor. This is `fcntl(fd, F_GETFD) & FD_CLOEXEC ==
///_CLOEXEC` under the covers.
#[napi]
#[allow(dead_code)]
fn get_close_on_exec(fd: i32) -> Result<bool, napi::Error> {
  match fcntl(fd as RawFd, FcntlArg::F_GETFD) {
    Ok(flags) => Ok(FdFlag::from_bits_truncate(flags).contains(FdFlag::FD_CLOEXEC)),
    Err(err) => Err(napi::Error::new(
      GenericFailure,
      format!("fcntl F_GETFD: {}", err,),
    )),
  }
}

/// Set the file descriptor to be non-blocking.
#[allow(dead_code)]
fn set_nonblocking(fd: i32) -> Result<(), napi::Error> {
  let old_flags = match fcntl(fd, FcntlArg::F_GETFL) {
    Ok(flags) => OFlag::from_bits_truncate(flags),
    Err(err) => {
      return Err(napi::Error::new(
        GenericFailure,
        format!("fcntl F_GETFL: {}", err),
      ));
    }
  };

  let mut new_flags = old_flags;
  new_flags.set(OFlag::O_NONBLOCK, true);
  if old_flags != new_flags {
    if let Err(err) = fcntl(fd, FcntlArg::F_SETFL(new_flags)) {
      return Err(napi::Error::new(
        GenericFailure,
        format!("fcntl F_SETFL: {}", err),
      ));
    }
  }
  Ok(())
}
