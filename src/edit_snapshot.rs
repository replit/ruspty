use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use nix::unistd::Pid;

const MAX_BYTES: u64 = 16 * 1024;

pub(crate) struct Snapshot {
  file: File,
  metadata: Metadata,
  bytes: String,
}

impl Snapshot {
  pub(crate) fn read(directory: &File, name: &OsStr) -> Option<Self> {
    if !matches!(Path::new(name).components().collect::<Vec<_>>().as_slice(), [Component::Normal(part)] if *part == name)
    {
      return None;
    }
    let path = Path::new("/proc/self/fd")
      .join(directory.as_raw_fd().to_string())
      .join(name);
    let file = OpenOptions::new()
      .read(true)
      .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
      .open(path)
      .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_BYTES {
      return None;
    }
    let mut bytes = String::new();
    (&file)
      .take(MAX_BYTES + 1)
      .read_to_string(&mut bytes)
      .ok()?;
    let end = file.metadata().ok()?;
    if bytes.len() as u64 != metadata.len()
      || bytes.contains('\0')
      || (metadata.ctime(), metadata.ctime_nsec()) != (end.ctime(), end.ctime_nsec())
    {
      return None;
    }
    Some(Self {
      file,
      metadata,
      bytes,
    })
  }

  fn read_path(path: &Path) -> Option<Self> {
    let parent = path.parent()?;
    let directory = File::open(parent).ok()?;
    let held_parent =
      std::fs::read_link(format!("/proc/self/fd/{}", directory.as_raw_fd())).ok()?;
    if held_parent != parent {
      return None;
    }
    Self::read(&directory, path.file_name()?)
  }

  // A successful rename links the source inode at the destination. Merely
  // seeing different bytes there after the command is not evidence of this.
  pub(crate) fn matches_replacement(&self, destination: &Self) -> bool {
    self.file.metadata().is_ok_and(|held| held.nlink() == 1)
      && (self.metadata.dev(), self.metadata.ino())
        == (destination.metadata.dev(), destination.metadata.ino())
      && self.bytes == destination.bytes
  }
}

/// Where a verified edit is reported, and which paths count as the workspace.
#[derive(Clone)]
pub struct CaptureOptions {
  pub root: PathBuf,
  pub output: std::os::fd::RawFd,
}

struct Rename {
  source_path: PathBuf,
  destination_path: PathBuf,
  before: Snapshot,
  source: Snapshot,
}

/// Records one rename-based replacement of a small text file under `root`.
/// Any other workspace mutation, a second edit, or a rename whose result
/// cannot be confirmed leaves nothing reported.
pub(crate) struct EditCapture {
  options: CaptureOptions,
  pending: HashMap<Pid, Rename>,
  edits: Vec<Rename>,
  touched: Vec<PathBuf>,
  tainted: bool,
}

impl EditCapture {
  pub(crate) fn new(options: CaptureOptions) -> Self {
    Self {
      options,
      pending: HashMap::new(),
      edits: Vec::new(),
      touched: Vec::new(),
      tainted: false,
    }
  }

  pub(crate) fn invalidate(&mut self) {
    self.tainted = true;
  }

  fn in_root(&self, path: &Path) -> bool {
    path.starts_with(&self.options.root) && !path.components().any(|c| c == Component::ParentDir)
  }

  /// Called at syscall entry with the paths the syscall writes or removes.
  /// `rename` is `(source, destination, flags)` for rename-family syscalls.
  pub(crate) fn entry(
    &mut self,
    pid: Pid,
    written: &[PathBuf],
    rename: Option<(&Path, &Path, u64)>,
  ) {
    if self.tainted {
      return;
    }
    for path in written {
      if path.starts_with(&self.options.root) {
        if !self.touched.contains(path) {
          if self.touched.len() == 2 {
            self.tainted = true;
            return;
          }
          self.touched.push(path.clone());
        }
      }
    }
    let Some((source_path, destination_path, flags)) = rename else {
      return;
    };
    if !self.in_root(destination_path) && !self.in_root(source_path) {
      return;
    }
    if !self.edits.is_empty() || !self.pending.is_empty() {
      self.tainted = true;
      return;
    }
    let rename = (flags == 0 && self.in_root(source_path) && self.in_root(destination_path))
      .then(|| {
        Some(Rename {
          source_path: source_path.to_path_buf(),
          destination_path: destination_path.to_path_buf(),
          before: Snapshot::read_path(destination_path)?,
          source: Snapshot::read_path(source_path)?,
        })
      })
      .flatten();
    match rename {
      Some(rename) => {
        self.pending.insert(pid, rename);
      }
      None => self.tainted = true,
    }
  }

  /// Called at syscall exit with the syscall's return value.
  pub(crate) fn exit(&mut self, pid: Pid, result: i64) {
    if let Some(rename) = self.pending.remove(&pid) {
      if result == 0 {
        self.edits.push(rename);
      } else {
        self.tainted = true;
      }
    }
  }

  /// Writes the edit when exactly one verified replacement explains every
  /// workspace mutation of a successful command.
  pub(crate) fn finish(self, exit_status: i32) {
    if exit_status != 0 || self.tainted || !self.pending.is_empty() {
      return;
    }
    let [edit] = self.edits.as_slice() else {
      return;
    };
    if !self
      .touched
      .iter()
      .all(|path| *path == edit.source_path || *path == edit.destination_path)
    {
      return;
    }
    let Some(after) = Snapshot::read_path(&edit.destination_path) else {
      return;
    };
    if !edit.source.matches_replacement(&after) || edit.before.bytes == after.bytes {
      return;
    }
    let Some(path) = edit.destination_path.to_str() else {
      return;
    };
    let json = format!(
      "{{\"path\":{},\"before\":{},\"after\":{}}}",
      json_string(path),
      json_string(&edit.before.bytes),
      json_string(&after.bytes)
    );
    unsafe {
      libc::send(
        self.options.output,
        json.as_ptr().cast(),
        json.len(),
        libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
      )
    };
  }
}

fn json_string(value: &str) -> String {
  let mut out = String::with_capacity(value.len() + 2);
  out.push('"');
  for c in value.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::os::unix::fs::symlink;

  #[test]
  fn checks_the_renamed_inode_not_just_matching_text() {
    let dir = tempfile::tempdir().unwrap();
    let root = File::open(dir.path()).unwrap();
    let read = |name: &str| Snapshot::read(&root, name.as_ref()).unwrap();
    fs::write(dir.path().join("output"), "Save").unwrap();
    fs::write(dir.path().join("temp"), "Save changes").unwrap();
    let old = read("output");
    let source = read("temp");
    fs::rename(dir.path().join("temp"), dir.path().join("output")).unwrap();
    assert_eq!(old.bytes, "Save");
    assert!(source.matches_replacement(&read("output")));
    fs::write(dir.path().join("other"), "Save changes").unwrap();
    fs::rename(dir.path().join("other"), dir.path().join("output")).unwrap();
    assert!(!source.matches_replacement(&read("output")));
  }

  #[test]
  fn skips_links_nontext_and_oversized_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let root = File::open(dir.path()).unwrap();
    fs::write(dir.path().join("bytes"), b"\0").unwrap();
    fs::write(dir.path().join("large"), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
    symlink("bytes", dir.path().join("link")).unwrap();
    for name in ["../bytes", "bytes", "large", "link"] {
      assert!(Snapshot::read(&root, name.as_ref()).is_none());
    }
  }
}
