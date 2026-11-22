//! The Library: films and shows recognised from transfer file names.
//!
//! Built on each request from the transfer list (cheap); only what can't be
//! derived is stored, in `<state>/library.json`: when stash first saw each
//! transfer (for "Recently added") and which files the user hid. Both are
//! keyed by info hash (+ file path), never by the derived title key, so a
//! better parser later doesn't orphan them.

pub mod parse;

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

use parse::{Kind, Quality};

const VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct State {
    #[serde(default)]
    pub version: u32,
    /// info hash → unix seconds when stash first listed it.
    #[serde(default)]
    pub first_seen: BTreeMap<String, u64>,
    /// `<info hash>/<path inside the torrent>` of hidden files.
    #[serde(default)]
    pub hidden: BTreeSet<String>,
    /// Title keys the user hid: keeps a show hidden when a new episode
    /// arrives. The per-file entries above survive a parser change that
    /// renames the key.
    #[serde(default)]
    pub hidden_keys: BTreeSet<String>,
}

/// Hide or unhide title `key` (its current files and the key itself).
pub fn set_hidden(state: &mut State, key: &str, file_ids: &[String], hide: bool) {
    for id in file_ids {
        if hide {
            state.hidden.insert(id.clone());
        } else {
            state.hidden.remove(id);
        }
    }
    if hide {
        state.hidden_keys.insert(key.to_string());
    } else {
        state.hidden_keys.remove(key);
    }
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

impl State {
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = std::fs::read(path) else {
            return Self::default();
        };
        match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(e) => {
                let mut bad = path.as_os_str().to_owned();
                bad.push(format!(".bad-{}", crate::seeding::unix_now()));
                let _ = std::fs::rename(path, PathBuf::from(bad));
                tracing::warn!(error = %e, "library.json unreadable; kept aside, starting fresh");
                Self::default()
            }
        }
    }

    /// Atomic save through a temp file with a unique name.
    pub fn save(&mut self, path: &Path) -> std::io::Result<()> {
        self.version = VERSION;
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(format!(
            ".tmp-{}-{}",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let tmp = PathBuf::from(tmp);
        let result = (|| {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
            f.sync_all()?;
            std::fs::rename(&tmp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }
}

/// One file of a transfer, as the Library needs it.
pub struct FileIn {
    pub fid: usize,
    pub components: Vec<String>,
    pub length: u64,
}

pub struct TransferIn {
    pub tid: usize,
    pub info_hash: String,
    /// None until a magnet's metadata arrives.
    pub files: Option<Vec<FileIn>>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TitleFile {
    pub tid: usize,
    pub fid: usize,
    /// File name (last path component).
    pub name: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub episodes: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub quality: Quality,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Title {
    pub key: String,
    pub kind: TitleKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u16>,
    /// Newest `first_seen` of its transfers (unix seconds).
    pub added: u64,
    pub hidden: bool,
    pub files: Vec<TitleFile>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TitleKind {
    Film,
    Show,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Library {
    pub titles: Vec<Title>,
    /// Transfers whose file list isn't known yet (magnet fetching metadata).
    pub pending: Vec<usize>,
    /// Files in transfers that aren't films or episodes (for the empty state).
    pub other_files: usize,
}

pub fn hidden_id(info_hash: &str, components: &[String]) -> String {
    format!("{info_hash}/{}", components.join("/"))
}

/// Record transfers seen for the first time; true when something changed.
pub fn note_first_seen(state: &mut State, hashes: &[&str], now: u64) -> bool {
    let mut changed = false;
    for h in hashes {
        if !state.first_seen.contains_key(*h) {
            state.first_seen.insert((*h).to_string(), now);
            changed = true;
        }
    }
    changed
}

/// Forget transfers that are gone (deleted from stash); true when changed.
/// Skipped when the listing looks partial (empty, or missing more than
/// half of what is known), so a startup race can't erase the state.
pub fn prune(state: &mut State, hashes: &[&str]) -> bool {
    let live: BTreeSet<&str> = hashes.iter().copied().collect();
    let known = state.first_seen.len();
    let missing = state
        .first_seen
        .keys()
        .filter(|h| !live.contains(h.as_str()))
        .count();
    if live.is_empty() || (known > 2 && missing * 2 > known) {
        return false;
    }
    let before = (state.first_seen.len(), state.hidden.len());
    state.first_seen.retain(|h, _| live.contains(h.as_str()));
    state
        .hidden
        .retain(|id| id.split_once('/').is_some_and(|(h, _)| live.contains(h)));
    before != (state.first_seen.len(), state.hidden.len())
}

/// Group every visible video file into titles. `deleted` files are
/// already excluded by the caller.
pub fn build(transfers: &[TransferIn], state: &State) -> Library {
    struct Acc {
        kind: TitleKind,
        names: BTreeMap<String, usize>,
        year: Option<u16>,
        added: u64,
        files: Vec<(TitleFile, bool)>,
    }
    let mut by_key: BTreeMap<String, Acc> = BTreeMap::new();
    let mut pending = Vec::new();
    let mut other_files = 0;
    for t in transfers {
        let Some(files) = &t.files else {
            pending.push(t.tid);
            continue;
        };
        let added = state.first_seen.get(&t.info_hash).copied().unwrap_or(0);
        for f in files {
            let p = parse::parse_file(&f.components);
            let Some(key) = parse::title_key(&p) else {
                if p.kind == Kind::Other
                    && parse::is_video(f.components.last().map_or("", String::as_str))
                {
                    other_files += 1;
                }
                continue;
            };
            let kind = if p.kind == Kind::Film {
                TitleKind::Film
            } else {
                TitleKind::Show
            };
            let acc = by_key.entry(key).or_insert_with(|| Acc {
                kind,
                names: BTreeMap::new(),
                year: p.year,
                added: 0,
                files: Vec::new(),
            });
            *acc.names.entry(p.title.clone()).or_default() += 1;
            acc.added = acc.added.max(added);
            if acc.year.is_none() {
                acc.year = p.year;
            }
            let hidden = state
                .hidden
                .contains(&hidden_id(&t.info_hash, &f.components));
            acc.files.push((
                TitleFile {
                    tid: t.tid,
                    fid: f.fid,
                    name: f.components.last().cloned().unwrap_or_default(),
                    size: f.length,
                    season: p.season,
                    episodes: p.episodes,
                    date: p.date,
                    quality: p.quality,
                },
                hidden,
            ));
        }
    }
    let mut titles: Vec<Title> = by_key
        .into_iter()
        .map(|(key, mut acc)| {
            // The spelling most files use; ties → the shortest.
            let title = acc
                .names
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.len().cmp(&a.0.len())))
                .map(|(n, _)| n.clone())
                .unwrap_or_default();
            acc.files.sort_by(|(a, _), (b, _)| {
                (a.season, a.episodes.first(), &a.date, a.tid, a.fid).cmp(&(
                    b.season,
                    b.episodes.first(),
                    &b.date,
                    b.tid,
                    b.fid,
                ))
            });
            let hidden = acc.files.iter().all(|(_, h)| *h) || state.hidden_keys.contains(&key);
            Title {
                key,
                kind: acc.kind,
                title,
                year: acc.year,
                added: acc.added,
                hidden,
                files: acc.files.into_iter().map(|(f, _)| f).collect(),
            }
        })
        .collect();
    titles.sort_by(|a, b| b.added.cmp(&a.added).then_with(|| a.title.cmp(&b.title)));
    Library {
        titles,
        pending,
        other_files,
    }
}

/// The hidden-set entries for every file of title `key`.
pub fn title_file_ids(transfers: &[TransferIn], key: &str) -> Vec<String> {
    let mut out = Vec::new();
    for t in transfers {
        for f in t.files.iter().flatten() {
            let p = parse::parse_file(&f.components);
            if parse::title_key(&p).as_deref() == Some(key) {
                out.push(hidden_id(&t.info_hash, &f.components));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(fid: usize, path: &str) -> FileIn {
        FileIn {
            fid,
            components: path.split('/').map(str::to_string).collect(),
            length: 1000,
        }
    }

    fn sample() -> Vec<TransferIn> {
        vec![
            TransferIn {
                tid: 0,
                info_hash: "aa".into(),
                files: Some(vec![
                    file(0, "Big Buck Bunny/Big Buck Bunny.mp4"),
                    file(1, "Big Buck Bunny/Big Buck Bunny.en.srt"),
                    file(2, "Big Buck Bunny/poster.jpg"),
                ]),
            },
            TransferIn {
                tid: 1,
                info_hash: "bb".into(),
                files: Some(vec![
                    file(0, "Friends.S01/Friends.S01E02.mkv"),
                    file(1, "Friends.S01/Friends.S01E01.mkv"),
                    file(2, "Friends.S01/Sample/sample.mkv"),
                ]),
            },
            TransferIn {
                tid: 2,
                info_hash: "cc".into(),
                files: None,
            },
        ]
    }

    #[test]
    fn groups_films_and_shows() {
        let mut state = State::default();
        assert!(note_first_seen(&mut state, &["aa", "bb"], 10));
        state.first_seen.insert("bb".into(), 20);
        assert!(!note_first_seen(&mut state, &["aa"], 30));
        let lib = build(&sample(), &state);
        assert_eq!(lib.pending, vec![2]);
        assert_eq!(lib.other_files, 1);
        let keys: Vec<&str> = lib.titles.iter().map(|t| t.key.as_str()).collect();
        // Newest first.
        assert_eq!(keys, ["show-friends", "film-big-buck-bunny"]);
        let friends = &lib.titles[0];
        assert_eq!(friends.kind, TitleKind::Show);
        assert_eq!(friends.added, 20);
        let eps: Vec<u32> = friends.files.iter().map(|f| f.episodes[0]).collect();
        assert_eq!(eps, [1, 2]);
        assert_eq!(lib.titles[1].files.len(), 1);
    }

    #[test]
    fn hiding_is_per_file_and_survives_rebuilds() {
        let ts = sample();
        let mut state = State::default();
        for id in title_file_ids(&ts, "show-friends") {
            state.hidden.insert(id);
        }
        let lib = build(&ts, &state);
        assert!(
            lib.titles
                .iter()
                .find(|t| t.key == "show-friends")
                .unwrap()
                .hidden
        );
        assert!(
            !lib.titles
                .iter()
                .find(|t| t.key == "film-big-buck-bunny")
                .unwrap()
                .hidden
        );
        assert!(state.hidden.contains("bb/Friends.S01/Friends.S01E01.mkv"));
        state.first_seen.insert("bb".into(), 1);
        state.first_seen.insert("gone".into(), 1);
        assert!(prune(&mut state, &["aa", "bb", "cc"]));
        assert!(!state.first_seen.contains_key("gone"));
        assert!(!state.hidden.is_empty());
        // Removing one of two is fine; an empty or mostly-missing listing
        // is treated as partial and ignored.
        assert!(!prune(&mut state, &[]));
        assert!(prune(&mut state, &["aa"]));
        assert!(state.hidden.is_empty());
        for h in ["x1", "x2", "x3", "x4"] {
            state.first_seen.insert(h.into(), 1);
        }
        assert!(!prune(&mut state, &["aa", "x1"]));
        assert_eq!(state.first_seen.len(), 4);
    }

    #[test]
    fn a_hidden_show_stays_hidden_when_episodes_arrive() {
        let mut ts = sample();
        let mut state = State::default();
        let ids = title_file_ids(&ts, "show-friends");
        set_hidden(&mut state, "show-friends", &ids, true);
        if let Some(files) = ts[1].files.as_mut() {
            files.push(file(3, "Friends.S01/Friends.S01E03.mkv"));
        }
        let lib = build(&ts, &state);
        assert!(
            lib.titles
                .iter()
                .find(|t| t.key == "show-friends")
                .unwrap()
                .hidden
        );
        set_hidden(
            &mut state,
            "show-friends",
            &title_file_ids(&ts, "show-friends"),
            false,
        );
        let lib = build(&ts, &state);
        assert!(
            !lib.titles
                .iter()
                .find(|t| t.key == "show-friends")
                .unwrap()
                .hidden
        );
        assert!(state.hidden.is_empty() && state.hidden_keys.is_empty());
    }

    #[test]
    fn state_round_trip_and_bad_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        assert_eq!(State::load(&path), State::default());
        let mut s = State::default();
        s.first_seen.insert("aa".into(), 5);
        s.hidden.insert("aa/x.mkv".into());
        s.save(&path).unwrap();
        let back = State::load(&path);
        assert_eq!(back.first_seen, s.first_seen);
        assert_eq!(back.version, VERSION);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(State::load(&path), State::default());
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".bad-")
            })
            .count();
        assert_eq!(kept, 1);
        // Old file without the new fields still loads.
        std::fs::write(&path, b"{}").unwrap();
        assert_eq!(State::load(&path), State::default());
    }
}
