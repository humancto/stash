//! Deleting one file of a transfer: path safety and disk removal.
//!
//! librqbit can't forget pieces it has, so a deleted file is deselected
//! (`only_files`) and removed from disk; the next start rechecks the
//! transfer once. librqbit recreates every file of a torrent on init, so a
//! 0-byte placeholder comes back on each start; it is removed again when
//! that is safe (see [`placeholder_removable`]).

use std::{
    ffi::CString,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};

use librqbit::file_info::FileInfo;

/// Why a delete was refused at the disk step.
#[derive(Debug)]
pub enum Refused {
    /// The path escapes the transfer's folder, or isn't a plain relative path.
    Outside,
    /// Not a regular file (symlink, directory, ...).
    NotAFile,
    /// Bigger than the torrent's file: something else replaced it.
    NotOurs,
    Io(io::Error),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Outside => f.write_str("the file's path is outside the download folder"),
            Self::NotAFile => f.write_str("the path is not a regular file"),
            Self::NotOurs => f.write_str("the file on disk is bigger than the torrent's file"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

/// Opens the folder holding `root/rel` by walking from the canonical root
/// one component at a time with `openat(O_NOFOLLOW)`, so nothing below the
/// root is resolved by path name again (no symlink swap between check and
/// use). `Ok(None)`: something on the way is gone, so the file is too.
fn open_parent(root: &Path, rel: &Path) -> Result<Option<(OwnedFd, CString)>, Refused> {
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(Refused::Outside);
    }
    let name = rel.file_name().ok_or(Refused::Outside)?;
    let root = match root.canonicalize() {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Refused::Io(e)),
    };
    let cstr = |s: &std::ffi::OsStr| CString::new(s.as_bytes()).map_err(|_| Refused::Outside);
    let open_dir = |at: Option<&OwnedFd>, part: &CString| -> Result<Option<OwnedFd>, Refused> {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
        // SAFETY: `part` is a valid C string and `at` a live fd.
        let fd = unsafe {
            match at {
                Some(d) => libc::openat(d.as_raw_fd(), part.as_ptr(), flags | libc::O_NOFOLLOW),
                None => libc::open(part.as_ptr(), flags),
            }
        };
        if fd >= 0 {
            // SAFETY: a fresh fd we own.
            return Ok(Some(unsafe { OwnedFd::from_raw_fd(fd) }));
        }
        let e = io::Error::last_os_error();
        match e.raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            // A symlink (or a file) where a folder should be.
            Some(libc::ELOOP | libc::ENOTDIR) => Err(Refused::Outside),
            _ => Err(Refused::Io(e)),
        }
    };
    let Some(mut dir) = open_dir(None, &cstr(root.as_os_str())?)? else {
        return Ok(None);
    };
    if let Some(parent) = rel.parent() {
        for part in parent.components() {
            let Some(next) = open_dir(Some(&dir), &cstr(part.as_os_str())?)? else {
                return Ok(None);
            };
            dir = next;
        }
    }
    Ok(Some((dir, cstr(name)?)))
}

fn unlink_at(dir: &OwnedFd, name: &CString) -> Result<(), Refused> {
    // SAFETY: valid fd and C string.
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    if e.kind() == io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(Refused::Io(e))
    }
}

/// Removes the file, returning the bytes freed. Truncates first (through
/// our own handle, so the space comes back even though librqbit keeps the
/// file open), unless other hard links share the data: then it only
/// unlinks this name and frees nothing. Missing = already gone.
pub fn remove(root: &Path, rel: &Path, torrent_len: u64) -> Result<u64, Refused> {
    let Some((dir, name)) = open_parent(root, rel)? else {
        return Ok(0);
    };
    // SAFETY: valid fd and C string.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let e = io::Error::last_os_error();
        return match e.raw_os_error() {
            Some(libc::ENOENT) => Ok(0),
            // O_NOFOLLOW on a symlink: ELOOP.
            Some(libc::ELOOP | libc::EISDIR) => Err(Refused::NotAFile),
            _ => Err(Refused::Io(e)),
        };
    }
    // SAFETY: a fresh fd we own.
    let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let meta = file.metadata().map_err(Refused::Io)?;
    if !meta.is_file() {
        return Err(Refused::NotAFile);
    }
    if meta.len() > torrent_len {
        return Err(Refused::NotOurs);
    }
    let freed = if meta.nlink() == 1 {
        let freed = meta.blocks().saturating_mul(512);
        file.set_len(0).map_err(Refused::Io)?;
        freed
    } else {
        0
    };
    drop(file);
    unlink_at(&dir, &name)?;
    Ok(freed)
}

/// Does file `fid` share a piece with another included, non-padding file?
/// librqbit then still needs (and rewrites) part of it, so the path must be
/// left alone after the delete.
pub fn shares_selected_piece(files: &[FileInfo], fid: usize, included: &[usize]) -> bool {
    let Some(f) = files.get(fid) else {
        return false;
    };
    let r = &f.piece_range;
    included.iter().any(|&o| {
        o != fid
            && files.get(o).is_some_and(|g| {
                !g.attrs.padding && g.piece_range.start < r.end && r.start < g.piece_range.end
            })
    })
}

/// A 0-byte placeholder librqbit recreated for a deleted file: removed when
/// it is a plain, unlinked-elsewhere, empty file. Returns whether it was.
pub fn remove_placeholder(root: &Path, rel: &Path) -> Result<bool, Refused> {
    let Some((dir, name)) = open_parent(root, rel)? else {
        return Ok(false);
    };
    // SAFETY: zeroed stat is a valid out-parameter; valid fd and C string.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc != 0 {
        let e = io::Error::last_os_error();
        return if e.kind() == io::ErrorKind::NotFound {
            Ok(false)
        } else {
            Err(Refused::Io(e))
        };
    }
    if (st.st_mode & libc::S_IFMT) != libc::S_IFREG || st.st_size != 0 || st.st_nlink != 1 {
        return Ok(false);
    }
    unlink_at(&dir, &name)?;
    Ok(true)
}

/// Files that count as "visible" for the last-file rule (the UI's `sole`).
pub fn visible(f: &FileInfo) -> bool {
    !f.attrs.padding && !f.attrs.hidden
}

#[cfg(test)]
mod tests {
    use super::*;
    use librqbit::FileDetailsAttrs;

    fn fi(start: u32, end: u32, padding: bool) -> FileInfo {
        FileInfo {
            relative_filename: std::path::PathBuf::from("x"),
            offset_in_torrent: 0,
            piece_range: start..end,
            attrs: FileDetailsAttrs {
                padding,
                ..Default::default()
            },
            len: 1,
        }
    }

    #[test]
    fn piece_sharing() {
        // a: pieces 0..3, b: 2..5 (shares piece 2), c: 5..6, d padding 5..6.
        let files = [
            fi(0, 3, false),
            fi(2, 5, false),
            fi(5, 6, false),
            fi(5, 6, true),
        ];
        // tail shared with an included neighbour
        assert!(shares_selected_piece(&files, 0, &[0, 1, 2]));
        // head shared
        assert!(shares_selected_piece(&files, 1, &[0, 1, 2]));
        // neighbour already deleted (not included) → nothing shared
        assert!(!shares_selected_piece(&files, 0, &[0, 2]));
        // only shares with a padding file → not shared
        assert!(!shares_selected_piece(&files, 2, &[1, 2, 3]));
        // c sits after b's last piece (ranges are half-open)
        assert!(!shares_selected_piece(&files, 2, &[0, 1, 2]));
        // a small file inside one piece between two kept files
        let small = [fi(0, 2, false), fi(1, 2, false), fi(1, 3, false)];
        assert!(shares_selected_piece(&small, 1, &[0, 2]));
        // out of range id
        assert!(!shares_selected_piece(&files, 9, &[0]));
    }

    #[test]
    fn path_guard() {
        let d = tempfile::tempdir().unwrap();
        for bad in ["../x", "/etc/passwd", "a/../../x", ""] {
            assert!(
                matches!(remove(d.path(), Path::new(bad), 9), Err(Refused::Outside)),
                "{bad}"
            );
        }
        // a symlinked directory pointing outside the root
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        std::fs::write(outside.path().join("f"), b"keep").unwrap();
        assert!(matches!(
            remove(d.path(), Path::new("link/f"), 9),
            Err(Refused::Outside)
        ));
        assert!(matches!(
            remove_placeholder(d.path(), Path::new("link/f")),
            Err(Refused::Outside)
        ));
        assert_eq!(std::fs::read(outside.path().join("f")).unwrap(), b"keep");
        // missing parent → already gone
        assert!(matches!(remove(d.path(), Path::new("no/such/f"), 9), Ok(0)));
        assert!(matches!(remove(d.path(), Path::new("missing"), 9), Ok(0)));
    }

    #[test]
    fn removes_and_frees_while_open() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("movie.mkv");
        std::fs::write(&p, vec![7u8; 64 * 1024]).unwrap();
        // librqbit's handle stays open across the delete.
        let held = std::fs::File::open(&p).unwrap();
        let freed = remove(d.path(), Path::new("movie.mkv"), 64 * 1024).unwrap();
        assert!(freed > 0);
        assert!(!p.exists());
        assert_eq!(held.metadata().unwrap().len(), 0, "inode truncated");
    }

    #[test]
    fn hardlink_keeps_data() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.mkv");
        std::fs::write(&p, b"precious").unwrap();
        let other = d.path().join("library.mkv");
        std::fs::hard_link(&p, &other).unwrap();
        assert_eq!(remove(d.path(), Path::new("a.mkv"), 8).unwrap(), 0);
        assert!(!p.exists());
        assert_eq!(std::fs::read(&other).unwrap(), b"precious");
    }

    #[test]
    fn refuses_symlink_dir_and_foreign_file() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("target");
        std::fs::write(&target, b"keep").unwrap();
        std::os::unix::fs::symlink(&target, d.path().join("ln")).unwrap();
        assert!(matches!(
            remove(d.path(), Path::new("ln"), 99),
            Err(Refused::NotAFile)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        std::fs::create_dir(d.path().join("dir")).unwrap();
        assert!(matches!(
            remove(d.path(), Path::new("dir"), 99),
            Err(Refused::NotAFile) | Err(Refused::Io(_))
        ));
        std::fs::write(d.path().join("big"), vec![0u8; 100]).unwrap();
        assert!(matches!(
            remove(d.path(), Path::new("big"), 10),
            Err(Refused::NotOurs)
        ));
        assert!(d.path().join("big").exists());
    }

    #[test]
    fn placeholder() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("empty"), b"").unwrap();
        std::fs::write(d.path().join("full"), b"x").unwrap();
        assert!(remove_placeholder(d.path(), Path::new("empty")).unwrap());
        assert!(!d.path().join("empty").exists());
        assert!(!remove_placeholder(d.path(), Path::new("full")).unwrap());
        assert!(d.path().join("full").exists());
        assert!(!remove_placeholder(d.path(), Path::new("gone")).unwrap());
        // empty but hard-linked elsewhere: left alone
        std::fs::write(d.path().join("e2"), b"").unwrap();
        std::fs::hard_link(d.path().join("e2"), d.path().join("e3")).unwrap();
        assert!(!remove_placeholder(d.path(), Path::new("e2")).unwrap());
    }
}
