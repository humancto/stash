//! Deleting one file of a transfer: path safety and disk removal.
//!
//! librqbit can't forget pieces it has, so a deleted file is deselected
//! (`only_files`) and removed from disk; the next start rechecks the
//! transfer once. librqbit recreates every file of a torrent on init, so a
//! 0-byte placeholder comes back on each start; it is removed again when
//! that is safe (see [`placeholder_removable`]).

use std::{
    fs::OpenOptions,
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
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

/// `root/rel`, with the parent canonicalized and checked to be inside the
/// canonical root. `Ok(None)`: the root or the parent no longer exists, so
/// the file is already gone.
pub fn resolve(root: &Path, rel: &Path) -> Result<Option<PathBuf>, Refused> {
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(Refused::Outside);
    }
    let name = rel.file_name().ok_or(Refused::Outside)?;
    let canon = |p: &Path| match p.canonicalize() {
        Ok(c) => Ok(Some(c)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Refused::Io(e)),
    };
    let Some(root) = canon(root)? else {
        return Ok(None);
    };
    let parent = root.join(rel);
    let parent = parent.parent().ok_or(Refused::Outside)?;
    let Some(parent) = canon(parent)? else {
        return Ok(None);
    };
    if !parent.starts_with(&root) {
        return Err(Refused::Outside);
    }
    Ok(Some(parent.join(name)))
}

/// Removes the file, returning the bytes freed. Truncates first (through
/// our own handle, so the space comes back even though librqbit keeps the
/// file open), unless other hard links share the data: then it only
/// unlinks this name and frees nothing. Missing = already gone.
pub fn remove(root: &Path, rel: &Path, torrent_len: u64) -> Result<u64, Refused> {
    let Some(path) = resolve(root, rel)? else {
        return Ok(0);
    };
    let file = match OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        // O_NOFOLLOW on a symlink: ELOOP.
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Err(Refused::NotAFile),
        Err(e) if e.raw_os_error() == Some(libc::EISDIR) => return Err(Refused::NotAFile),
        Err(e) => return Err(Refused::Io(e)),
    };
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
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(freed),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(freed),
        Err(e) => Err(Refused::Io(e)),
    }
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
    let Some(path) = resolve(root, rel)? else {
        return Ok(false);
    };
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(Refused::Io(e)),
    };
    if !meta.is_file() || meta.len() != 0 || meta.nlink() != 1 {
        return Ok(false);
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Refused::Io(e)),
    }
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
            relative_filename: PathBuf::from("x"),
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
                matches!(resolve(d.path(), Path::new(bad)), Err(Refused::Outside)),
                "{bad}"
            );
        }
        // a symlinked directory pointing outside the root
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        assert!(matches!(
            resolve(d.path(), Path::new("link/f")),
            Err(Refused::Outside)
        ));
        // missing parent → already gone
        assert!(matches!(
            resolve(d.path(), Path::new("no/such/f")),
            Ok(None)
        ));
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
