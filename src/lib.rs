use std::collections::HashMap;
use std::io::Error;
use std::io::ErrorKind;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;

use libc::{self, c_int};
use napi::bindgen_prelude::{Buffer, JsFunction};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status::GenericFailure;
use napi::{self, Env};
use rustix::event::{poll, PollFd, PollFlags};
use rustix_openpty::openpty;
use rustix_openpty::rustix::termios::{self, InputModes, OptionalActions, Winsize};

#[macro_use]
extern crate napi_derive;

/// A very thin wrapper around PTYs and processes. The caller is responsible for calling `.close()`
/// when all streams have been closed. We hold onto both ends of the PTY (controller and user) to
/// prevent reads from erroring out with EIO.
///
/// This is the recommended usage:
///
/// ```
/// const { Pty } = require('replit-ruspy');
/// const fs = require('node:fs');
///
/// const pty = new Pty('sh', [], ENV, CWD, { rows: 24, cols: 80 }, (...result) => {
///   pty.close();
///   // TODO: Handle process exit.
/// });
///
/// const read = new fs.createReadStream('', {
///   fd: pty.fd(),
///   start: 0,
///   highWaterMark: 16 * 1024,
///   autoClose: true,
/// });
/// const write = new fs.createWriteStream('', {
///   fd: pty.fd(),
///   autoClose: true,
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
///
/// The last parameter (a callback that gets stdin chunks) is optional and is only there for
/// compatibility with bun 1.1.7.
#[napi]
#[allow(dead_code)]
struct Pty {
  controller_fd: Option<OwnedFd>,
  user_fd: Option<OwnedFd>,
  should_dup_fds: bool,
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
  #[napi(ts_type = "(err: null | Error, data: Buffer) => void")]
  pub on_data: Option<JsFunction>,
}

/// A size struct to pass to resize.
#[napi(object)]
struct Size {
  pub cols: u16,
  pub rows: u16,
}

#[allow(dead_code)]
fn set_controlling_terminal(fd: c_int) -> Result<(), Error> {
  let res = unsafe {
    #[allow(clippy::cast_lossless)]
    libc::ioctl(fd, libc::TIOCSCTTY as _, 0)
  };

  if res != 0 {
    return Err(Error::last_os_error());
  }

  Ok(())
}

#[allow(dead_code)]
fn set_nonblocking(fd: c_int) -> Result<(), napi::Error> {
  use libc::{fcntl, F_GETFL, F_SETFL, O_NONBLOCK};

  let status_flags = unsafe { fcntl(fd, F_GETFL, 0) };

  if status_flags < 0 {
    return Err(napi::Error::new(
      napi::Status::GenericFailure,
      format!("fcntl F_GETFL failed: {}", Error::last_os_error()),
    ));
  }

  let res = unsafe { fcntl(fd, F_SETFL, status_flags | O_NONBLOCK) };

  if res != 0 {
    return Err(napi::Error::new(
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
  pub fn new(env: Env, opts: PtyOptions) -> Result<Self, napi::Error> {
    let should_dup_fds = env.get_node_version()?.release == "node";
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

    let rustix_openpty::Pty {
      controller: controller_fd,
      user: user_fd,
    } = openpty(None, Some(&window_size))
      .map_err(|err| napi::Error::new(napi::Status::GenericFailure, err))?;

    if let Ok(mut termios) = termios::tcgetattr(&controller_fd) {
      termios.input_modes.set(InputModes::IUTF8, true);
      termios::tcsetattr(&controller_fd, OptionalActions::Now, &termios)
        .map_err(|err| napi::Error::new(napi::Status::GenericFailure, err))?;
    }

    // The Drop implementation for Command will try to close _each_ stdio. That implies that it
    // will try to close the three of them, so if we don't dup them, Rust will try to close the
    // same FD three times, and if stars don't align, we might be even closing a different FD
    // accidentally.
    cmd.stdin(Stdio::from(user_fd.try_clone()?));
    cmd.stderr(Stdio::from(user_fd.try_clone()?));
    cmd.stdout(Stdio::from(user_fd.try_clone()?));

    if let Some(envs) = opts.envs {
      cmd.envs(envs);
    }
    if let Some(dir) = opts.dir {
      cmd.current_dir(dir);
    }

    unsafe {
      let raw_user_fd = user_fd.as_raw_fd();
      let raw_controller_fd = controller_fd.as_raw_fd();
      cmd.pre_exec(move || {
        let err = libc::setsid();
        if err == -1 {
          return Err(Error::new(ErrorKind::Other, "Failed to set session id"));
        }

        // stdin is wired to the tty, so we can use that for the controlling terminal.
        set_controlling_terminal(0)?;

        libc::close(raw_user_fd);
        libc::close(raw_controller_fd);

        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
        libc::signal(libc::SIGHUP, libc::SIG_DFL);
        libc::signal(libc::SIGINT, libc::SIG_DFL);
        libc::signal(libc::SIGQUIT, libc::SIG_DFL);
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        libc::signal(libc::SIGALRM, libc::SIG_DFL);

        Ok(())
      });
    }

    let mut child = cmd
      .spawn()
      .map_err(|err| napi::Error::new(GenericFailure, err))?;

    // We are marking the pty fd as non-blocking, despite Node's docs suggesting that the fd passed
    // to `createReadStream`/`createWriteStream` should be blocking.
    set_nonblocking(controller_fd.as_raw_fd())?;
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
    let ts_on_data = opts
      .on_data
      .map(|on_data| {
        Ok::<
          (
            ThreadsafeFunction<Buffer, ErrorStrategy::CalleeHandled>,
            OwnedFd,
          ),
          napi::Error,
        >((
          on_data.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?,
          match controller_fd.try_clone() {
            Ok(fd) => Ok(fd),
            Err(err) => Err(napi::Error::new(
              GenericFailure,
              format!(
                "OS error when setting up child process wait: {}",
                err.raw_os_error().unwrap_or(-1)
              ),
            )),
          }?,
        ))
      })
      .transpose()?;
    thread::spawn(move || {
      #[cfg(target_os = "linux")]
      {
        // The following code only works on Linux due to the reliance on pidfd.
        use rustix::process::{pidfd_open, Pid, PidfdFlags};

        if let Some((ts_on_data, controller_fd)) = ts_on_data {
          if let Err(err) = || -> Result<(), napi::Error> {
            let pidfd = pidfd_open(
              unsafe { Pid::from_raw_unchecked(child.id() as i32) },
              PidfdFlags::empty(),
            )
            .map_err(|err| napi::Error::new(GenericFailure, format!("pidfd_open: {:#?}", err)))?;
            let mut poll_fds = [
              PollFd::new(&controller_fd, PollFlags::IN),
              PollFd::new(&pidfd, PollFlags::IN),
            ];
            let mut buf = [0u8; 16 * 1024];
            loop {
              for poll_fd in &mut poll_fds[..] {
                poll_fd.clear_revents();
              }
              poll(&mut poll_fds, -1).map_err(|err| {
                napi::Error::new(
                  GenericFailure,
                  format!("OS error when waiting for child read: {:#?}", err),
                )
              })?;
              // Always check the controller FD first to see if it has any events.
              if poll_fds[0].revents().contains(PollFlags::IN) {
                match rustix::io::read(&controller_fd, &mut buf) {
                  Ok(n) => {
                    ts_on_data.call(
                      Ok(buf[..n as usize].into()),
                      ThreadsafeFunctionCallMode::Blocking,
                    );
                  }
                  Err(errno) => {
                    if errno == rustix::io::Errno::AGAIN || errno == rustix::io::Errno::INTR {
                      // These two errors are safe to retry.
                      continue;
                    }
                    if errno == rustix::io::Errno::IO {
                      // This error happens when the child closes. We can simply break the loop.
                      return Ok(());
                    }
                    return Err(napi::Error::new(
                      GenericFailure,
                      format!("OS error when reading from child: {:#?}", errno,),
                    ));
                  }
                }
                // If there was data, keep trying to read this FD.
                continue;
              }

              // Now that we're sure that the controller FD doesn't have any events, we have
              // successfully drained the child's output, so we can now check if the child has
              // exited.
              if poll_fds[1].revents().contains(PollFlags::IN) {
                return Ok(());
              }
            }
          }() {
            ts_on_data.call(Err(err), ThreadsafeFunctionCallMode::Blocking);
          }
        }
      }
      #[cfg(not(target_os = "linux"))]
      {
        if let Some((ts_on_data, _controller_fd)) = ts_on_data {
          ts_on_data.call(
            Err(napi::Error::new(
              GenericFailure,
              "the data callback is only implemented in Linux",
            )),
            ThreadsafeFunctionCallMode::Blocking,
          );
        }
      }
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
      should_dup_fds,
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

      if res != 0 {
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

  /// Returns a file descriptor for the PTY controller. If running under node, it will dup the file
  /// descriptor, but under bun it will return the same file desciptor, since bun does not close
  /// the streams by itself. Maybe that is a bug in bun, so we should confirm the new behavior
  /// after we upgrade.
  ///
  /// See the docstring of the class for an usage example.
  #[napi]
  #[allow(dead_code)]
  pub fn fd(&mut self) -> Result<c_int, napi::Error> {
    if let Some(fd) = &self.controller_fd {
      if !self.should_dup_fds {
        return Ok(fd.as_raw_fd());
      }
      let res = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
      if res < 0 {
        return Err(napi::Error::new(
          napi::Status::GenericFailure,
          format!("fcntl F_DUPFD_CLOEXEC failed: {}", Error::last_os_error()),
        ));
      }
      Ok(res)
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
    let controller_fd = self.controller_fd.take();
    let user_fd = self.user_fd.take();
    if controller_fd.is_none() {
      return Err(napi::Error::new(
        napi::Status::GenericFailure,
        format!("close failed: {}", libc::EBADF),
      ));
    }
    drop(user_fd);

    Ok(())
  }
}
