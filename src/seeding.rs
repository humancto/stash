//! Seeding policy: stop sharing a transfer once it has finished (default),
//! or after a ratio or a time, or never.
//!
//! librqbit's `uploaded_bytes` only counts while a torrent is live and
//! resets on every pause, restart and re-exec, so stash keeps its own
//! cumulative counter per info-hash in `<state>/seeding.json`.
//!
//! Lock order everywhere: the privacy write gate, then the seeding lock.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use librqbit::{
    Api, TorrentStatsState,
    api::{ApiTorrentListOpts, EmptyJsonResponse, TorrentIdOrHash},
};
use serde::{Deserialize, Serialize};

use crate::{
    filedelete,
    privacy::{From_, Privacy},
};

const TICK: Duration = Duration::from_secs(2);
const SAVE_EVERY: Duration = Duration::from_secs(10);
const MIN_RATIO: f64 = 0.1;
const MAX_RATIO: f64 = 100.0;
const MAX_MINUTES: u32 = 365 * 24 * 60;

// ---------- policy ----------

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Policy {
    /// Stop sharing once the download finishes.
    Stop,
    /// Stop once uploaded ≥ ratio × the selected size.
    Ratio { ratio: f64 },
    /// Stop this many minutes after stash first saw it finished.
    Time { minutes: u32 },
    /// Never stop.
    Forever,
}

impl Policy {
    pub fn validate(self) -> Result<Self, String> {
        match self {
            Self::Ratio { ratio }
                if !(ratio.is_finite() && (MIN_RATIO..=MAX_RATIO).contains(&ratio)) =>
            {
                Err(format!("ratio must be between {MIN_RATIO} and {MAX_RATIO}"))
            }
            Self::Time { minutes } if !(1..=MAX_MINUTES).contains(&minutes) => {
                Err("time must be between 1 minute and 365 days".into())
            }
            p => Ok(p),
        }
    }

    /// `STASH_SEEDING`: `stop` | `forever` | `ratio:1.5` | `time:90m|24h|7d`.
    pub fn parse(v: &str) -> anyhow::Result<Self> {
        let v = v.trim().to_ascii_lowercase();
        let bad = || {
            anyhow::anyhow!(
                "STASH_SEEDING must be stop, forever, ratio:R or time:Nm|Nh|Nd (got {v:?})"
            )
        };
        let p = match v.as_str() {
            "stop" => Self::Stop,
            "forever" => Self::Forever,
            _ => {
                if let Some(r) = v.strip_prefix("ratio:") {
                    Self::Ratio {
                        ratio: r.parse::<f64>().map_err(|_| bad())?,
                    }
                } else if let Some(t) = v.strip_prefix("time:") {
                    // strip_suffix, not byte slicing: input may be non-ASCII.
                    let (n, mult) = if let Some(n) = t.strip_suffix('m') {
                        (n, 1)
                    } else if let Some(n) = t.strip_suffix('h') {
                        (n, 60)
                    } else if let Some(n) = t.strip_suffix('d') {
                        (n, 24 * 60)
                    } else {
                        return Err(bad());
                    };
                    if !n.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(bad());
                    }
                    let n: u32 = n.parse().map_err(|_| bad())?;
                    Self::Time {
                        minutes: n.checked_mul(mult).ok_or_else(bad)?,
                    }
                } else {
                    return Err(bad());
                }
            }
        };
        p.validate()
            .map_err(|e| anyhow::anyhow!("STASH_SEEDING: {e}"))
    }
}

// ---------- persisted state ----------

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    /// First time stash saw it finished (unix seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default)]
    pub uploaded_base_bytes: u64,
    #[serde(default)]
    pub last_live_uploaded_bytes: u64,
    /// boot_id of the process that recorded `last_live_uploaded_bytes`.
    #[serde(default)]
    pub last_boot: String,
    /// Paused by the seeding rule (not by the user).
    #[serde(default)]
    pub stopped_by_rule: bool,
    /// Started by stash (not the user) to fetch pieces lost in the recheck
    /// after a file delete. Cleared when the rule pauses it or the user acts.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repairing: bool,
}

impl Entry {
    /// Folds the live counter into the base when it can't continue: another
    /// process, not live, or it went backwards (pause/restart reset it).
    pub fn account(&mut self, boot: &str, live_uploaded: Option<u64>) {
        let fold = |e: &mut Self| {
            e.uploaded_base_bytes = e
                .uploaded_base_bytes
                .saturating_add(e.last_live_uploaded_bytes);
            e.last_live_uploaded_bytes = 0;
        };
        if self.last_boot != boot {
            fold(self);
            self.last_boot = boot.to_string();
        }
        match live_uploaded {
            None => fold(self),
            Some(u) => {
                if u < self.last_live_uploaded_bytes {
                    fold(self);
                }
                self.last_live_uploaded_bytes = u;
            }
        }
    }

    pub fn uploaded(&self) -> u64 {
        self.uploaded_base_bytes
            .saturating_add(self.last_live_uploaded_bytes)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SeedState {
    #[serde(default)]
    pub keep_seeding: BTreeSet<String>,
    #[serde(default)]
    pub torrents: BTreeMap<String, Entry>,
    /// Files deleted from a transfer: hash → file id → progress.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub deleted: BTreeMap<String, BTreeMap<usize, Deletion>>,
    /// Transfers whose next start rechecks every piece (a file was deleted):
    /// hash → boot id of the process that deleted it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub recheck_pending: BTreeMap<String, String>,
}

/// A file deletion: recorded before anything changes, done once the file is
/// off the disk. A pending one left by a crash or re-exec is finished by the
/// enforcer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Deletion {
    Pending,
    Done,
}

impl SeedState {
    /// Unreadable file → kept aside as `seeding.json.bad-<ts>`, start empty.
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = std::fs::read(path) else {
            return Self::default();
        };
        match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(e) => {
                let mut bad = path.as_os_str().to_owned();
                bad.push(format!(".bad-{}", unix_now()));
                let _ = std::fs::rename(path, PathBuf::from(bad));
                tracing::warn!(error = %e, "seeding.json unreadable; kept aside, starting fresh");
                Self::default()
            }
        }
    }

    fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    }
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Has this transfer seeded enough? Only meaningful once it finished.
pub fn done(policy: Policy, e: &Entry, total_bytes: u64, now: u64) -> bool {
    match policy {
        Policy::Stop => true,
        Policy::Forever => false,
        Policy::Ratio { ratio } => {
            total_bytes == 0 || e.uploaded() as f64 >= ratio * total_bytes as f64
        }
        Policy::Time { minutes } => e
            .finished_at
            .is_some_and(|t| now.saturating_sub(t) >= u64::from(minutes) * 60),
    }
}

/// What the enforcer should do with one transfer.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Leave,
    Pause,
}

pub struct View {
    pub finished: bool,
    pub live: bool,
    /// Initializing and not paused: about to go live.
    pub starting: bool,
    pub total_bytes: u64,
    /// A file was deleted, so this start rechecks every piece.
    pub recheck_pending: bool,
}

pub fn decide(policy: Policy, keep: bool, e: &Entry, v: &View, now: u64) -> Verdict {
    if keep || policy == Policy::Forever {
        return Verdict::Leave;
    }
    // While initializing, `finished` is not known yet; a torrent stash has
    // already seen finished is paused before it can announce as a seeder.
    // Not while a recheck is pending: pausing then aborts the check and
    // leaves the transfer unverified (nothing in it could stream). Not while
    // stash is repairing it either: it was only live to fetch pieces lost
    // after a file delete, so it isn't known to be finished.
    let finished =
        v.finished || (v.starting && !v.recheck_pending && !e.repairing && e.finished_at.is_some());
    if (v.live || v.starting) && finished && done(policy, e, v.total_bytes, now) {
        Verdict::Pause
    } else {
        Verdict::Leave
    }
}

// ---------- runtime ----------

pub struct Seeding {
    policy: RwLock<(Policy, From_)>,
    pub state: tokio::sync::Mutex<SeedState>,
    path: PathBuf,
    boot: String,
    /// Transfers whose placeholders were cleaned this boot.
    cleaned: std::sync::Mutex<HashSet<String>>,
}

#[derive(Serialize)]
pub struct TransferSeeding {
    pub keep: bool,
    pub uploaded_bytes: u64,
    pub finished_at: Option<u64>,
    pub stopped_by_rule: bool,
    /// Unix time the time limit ends (time mode, still seeding).
    pub stops_at: Option<u64>,
    /// Bytes to upload before the ratio is met (ratio mode).
    pub target_bytes: Option<u64>,
}

fn live_uploaded(st: &librqbit::TorrentStats) -> Option<u64> {
    matches!(st.state, TorrentStatsState::Live).then_some(st.uploaded_bytes)
}

fn view_of(st: &librqbit::TorrentStats, recheck_pending: bool) -> View {
    View {
        finished: st.finished,
        live: matches!(st.state, TorrentStatsState::Live),
        starting: matches!(st.state, TorrentStatsState::Initializing { paused: false }),
        total_bytes: st.total_bytes,
        recheck_pending,
    }
}

/// Why deleting one file was refused.
#[derive(Debug)]
pub enum DeleteError {
    Api(librqbit::ApiError),
    NoSuchFile,
    /// Initializing or metadata not resolved yet.
    Checking,
    LastFile,
    /// Deselected, but the file on disk was left alone.
    Disk(filedelete::Refused),
}

impl From<librqbit::ApiError> for DeleteError {
    fn from(e: librqbit::ApiError) -> Self {
        Self::Api(e)
    }
}

/// Should the enforcer restart a transfer (one with deleted files) to fetch
/// pieces it lost in the recheck after a delete? Only one the rule had
/// stopped (never one the user paused), once the recheck is over. Any other
/// cause of a rule-stopped transfer going unfinished (say, disk damage
/// found by a recheck) gets the same treatment, which is what it needs too.
pub fn needs_repair(
    paused: bool,
    finished: bool,
    stopped_by_rule: bool,
    recheck_pending: bool,
) -> bool {
    paused && !finished && stopped_by_rule && !recheck_pending
}

/// What deleting file `fid` has to do, from the torrent's file list, the
/// current selection and whether an earlier attempt is pending.
#[derive(Debug, PartialEq, Eq)]
pub enum DeleteStep {
    /// Already deleted: never touch the path again (it may hold pieces a
    /// kept neighbour needs).
    Nothing,
    /// Deselect, then remove from disk.
    Deselect,
    /// Deselected by an attempt that didn't finish: the disk step only.
    Recover,
}

pub fn plan_delete(
    files: &[librqbit::file_info::FileInfo],
    included: &[usize],
    fid: usize,
    pending: bool,
) -> Result<DeleteStep, DeleteError> {
    files
        .get(fid)
        .filter(|f| !f.attrs.padding)
        .ok_or(DeleteError::NoSuchFile)?;
    if !included.contains(&fid) {
        return Ok(if pending {
            DeleteStep::Recover
        } else {
            DeleteStep::Nothing
        });
    }
    let others = included
        .iter()
        .any(|&o| o != fid && files.get(o).is_some_and(filedelete::visible));
    if others {
        Ok(DeleteStep::Deselect)
    } else {
        Err(DeleteError::LastFile)
    }
}

/// "Already paused" from librqbit is success; checked by state, not text.
fn is_paused(api: &Api, id: TorrentIdOrHash) -> bool {
    api.mgr_handle(id).is_ok_and(|h| {
        matches!(
            h.stats().state,
            TorrentStatsState::Paused | TorrentStatsState::Initializing { paused: true }
        )
    })
}

impl Seeding {
    pub fn new(policy: Policy, from: From_, state_dir: &Path, boot: &str) -> Self {
        let path = state_dir.join("seeding.json");
        Self {
            policy: RwLock::new((policy, from)),
            state: tokio::sync::Mutex::new(SeedState::load(&path)),
            path,
            boot: boot.to_string(),
            cleaned: Default::default(),
        }
    }

    pub fn policy(&self) -> (Policy, From_) {
        *self
            .policy
            .read()
            .expect("BUG: seeding policy lock poisoned")
    }

    pub fn set_policy(&self, p: Policy) {
        let mut g = self
            .policy
            .write()
            .expect("BUG: seeding policy lock poisoned");
        g.0 = p;
        g.1 = From_::File;
    }

    async fn save(&self, s: &SeedState) {
        let snapshot = s.clone();
        let path = self.path.clone();
        let result = tokio::task::spawn_blocking(move || snapshot.save(&path))
            .await
            .map_err(std::io::Error::other)
            .and_then(|r| r);
        if let Err(e) = result {
            tracing::warn!(error = %e, "could not save seeding.json");
        }
    }

    /// Best effort before exec or exit: never blocks (try_lock).
    pub fn flush_now(&self) {
        match self.state.try_lock() {
            Ok(s) => {
                if let Err(e) = s.save(&self.path) {
                    tracing::warn!(error = %e, "could not save seeding.json before stopping");
                }
            }
            Err(_) => tracing::debug!("seeding state busy; skipped the final save"),
        }
    }

    /// Per-transfer view for `/api/transfers`.
    pub fn view(&self, s: &SeedState, hash: &str, total_bytes: u64) -> TransferSeeding {
        let (policy, _) = self.policy();
        let e = s.torrents.get(hash).cloned().unwrap_or_default();
        let keep = policy != Policy::Forever && s.keep_seeding.contains(hash);
        TransferSeeding {
            keep,
            uploaded_bytes: e.uploaded(),
            finished_at: e.finished_at,
            stopped_by_rule: e.stopped_by_rule,
            stops_at: match policy {
                Policy::Time { minutes } => e
                    .finished_at
                    .map(|t| t.saturating_add(u64::from(minutes) * 60)),
                _ => None,
            },
            target_bytes: match policy {
                Policy::Ratio { ratio } => Some((ratio * total_bytes as f64).ceil() as u64),
                _ => None,
            },
        }
    }

    /// A user's Start. Holds the seeding lock across the librqbit call so
    /// the enforcer can't act in between; stats are read under the lock.
    /// Keeps it seeding only if the rule already considers it done (no
    /// ratio/time bypass), using the same "known finished" test as decide().
    pub async fn user_start(
        &self,
        api: &Api,
        id: TorrentIdOrHash,
    ) -> Result<EmptyJsonResponse, librqbit::ApiError> {
        let mut s = self.state.lock().await;
        let h = api.mgr_handle(id)?;
        let hash = h.shared().info_hash.as_string();
        let st = h.stats();
        let (policy, _) = self.policy();
        let e = s.torrents.entry(hash.clone()).or_default();
        e.account(&self.boot, live_uploaded(&st));
        e.stopped_by_rule = false;
        e.repairing = false;
        let known_finished = st.finished || e.finished_at.is_some();
        if known_finished
            && policy != Policy::Forever
            && done(policy, e, st.total_bytes, unix_now())
        {
            s.keep_seeding.insert(hash);
        }
        self.save(&s).await;
        api.api_torrent_action_start(id).await
    }

    /// A user's Pause: fold the counter, forget the override, pause — all
    /// under the seeding lock.
    pub async fn user_pause(
        &self,
        api: &Api,
        id: TorrentIdOrHash,
    ) -> Result<EmptyJsonResponse, librqbit::ApiError> {
        let mut s = self.state.lock().await;
        let h = api.mgr_handle(id)?;
        let hash = h.shared().info_hash.as_string();
        let st = h.stats();
        let e = s.torrents.entry(hash.clone()).or_default();
        e.account(&self.boot, live_uploaded(&st));
        e.stopped_by_rule = false;
        e.repairing = false;
        s.keep_seeding.remove(&hash);
        self.save(&s).await;
        api.api_torrent_action_pause(id).await
    }

    /// A user's Delete: entries are only ever removed here.
    pub async fn user_delete(
        &self,
        api: &Api,
        id: TorrentIdOrHash,
    ) -> Result<EmptyJsonResponse, librqbit::ApiError> {
        let mut s = self.state.lock().await;
        let hash = api.mgr_handle(id)?.shared().info_hash.as_string();
        let resp = api.api_torrent_action_delete(id).await?;
        let a = s.torrents.remove(&hash).is_some();
        let b = s.keep_seeding.remove(&hash);
        // A re-added transfer with the same hash starts clean: its files are
        // never treated as deleted.
        let c = s.deleted.remove(&hash).is_some();
        let d = s.recheck_pending.remove(&hash).is_some();
        if a || b || c || d {
            self.save(&s).await;
        }
        Ok(resp)
    }

    /// File ids deleted from this transfer, for the UI.
    pub fn deleted_files(s: &SeedState, hash: &str) -> Vec<usize> {
        s.deleted
            .get(hash)
            .map(|m| m.keys().copied().collect())
            .unwrap_or_default()
    }

    /// A user's (or a resumed) delete of one file. The caller holds the
    /// privacy write guard. Order: record the intent, deselect, remove from
    /// disk, mark done; the seeding lock is held for the first two only.
    /// Returns the bytes freed on disk.
    pub async fn delete_file(
        &self,
        api: &Api,
        id: TorrentIdOrHash,
        fid: usize,
    ) -> Result<u64, DeleteError> {
        let (hash, root, rel, len, step, shares) = {
            let mut s = self.state.lock().await;
            let h = api.mgr_handle(id)?;
            let hash = h.info_hash().as_string();
            if matches!(h.stats().state, TorrentStatsState::Initializing { .. }) {
                return Err(DeleteError::Checking);
            }
            let files = h
                .with_metadata(|m| m.file_infos.clone())
                .map_err(|_| DeleteError::Checking)?;
            let included: Vec<usize> = h.only_files().unwrap_or_else(|| (0..files.len()).collect());
            let pending =
                s.deleted.get(&hash).and_then(|m| m.get(&fid)) == Some(&Deletion::Pending);
            let step = plan_delete(&files, &included, fid, pending)?;
            if step == DeleteStep::Nothing {
                return Ok(0);
            }
            let keep: Vec<usize> = included.into_iter().filter(|&o| o != fid).collect();
            s.deleted
                .entry(hash.clone())
                .or_default()
                .insert(fid, Deletion::Pending);
            if step == DeleteStep::Deselect {
                // Recorded first: a crash after the disk step must still
                // keep the next start's recheck from being aborted.
                let prev = s.recheck_pending.insert(hash.clone(), self.boot.clone());
                self.save(&s).await;
                let set: HashSet<usize> = keep.iter().copied().collect();
                if let Err(e) = api.api_torrent_action_update_only_files(id, &set).await {
                    // The user sees this fail: nothing may finish it later.
                    if let Some(m) = s.deleted.get_mut(&hash) {
                        m.remove(&fid);
                        if m.is_empty() {
                            s.deleted.remove(&hash);
                        }
                    }
                    match prev {
                        Some(b) => s.recheck_pending.insert(hash.clone(), b),
                        None => s.recheck_pending.remove(&hash),
                    };
                    self.save(&s).await;
                    return Err(e.into());
                }
            }
            let f = &files[fid];
            (
                hash,
                h.output_folder().to_path_buf(),
                f.relative_filename.clone(),
                f.len,
                step,
                filedelete::shares_selected_piece(&files, fid, &keep),
            )
        };
        let result = tokio::task::spawn_blocking(move || {
            // Recovering in a later start: librqbit may have recreated an
            // empty file there that a kept neighbour's piece will be written
            // into; unlinking it would cost another full recheck.
            if step == DeleteStep::Recover
                && shares
                && matches!(filedelete::size_on_disk(&root, &rel)?, None | Some(0))
            {
                return Ok(filedelete::Removed::default());
            }
            filedelete::remove(&root, &rel, len)
        })
        .await
        .unwrap_or_else(|e| Err(filedelete::Refused::Io(std::io::Error::other(e))));
        let mut s = self.state.lock().await;
        // Done either way: a refused path is left alone (and reported), not
        // retried forever. Gone if the transfer was deleted meanwhile.
        if let Some(d) = s.deleted.get_mut(&hash).and_then(|m| m.get_mut(&fid)) {
            *d = Deletion::Done;
        }
        if let Ok(r) = &result
            && r.had_data
        {
            // Data left the path: the next start rechecks.
            s.recheck_pending.insert(hash.clone(), self.boot.clone());
        }
        self.save(&s).await;
        match result {
            Ok(r) => {
                tracing::info!(info_hash = %hash, file = fid, freed = r.freed, "deleted a file");
                Ok(r.freed)
            }
            Err(e) => {
                tracing::warn!(info_hash = %hash, file = fid, error = %e, "deselected a file but left it on disk");
                Err(DeleteError::Disk(e))
            }
        }
    }

    /// After a delete: finish pending deletions, remove 0-byte placeholders
    /// librqbit recreated (once per boot), and restart a rule-stopped
    /// transfer that lost pieces in its recheck.
    async fn tend_deletions(&self, privacy: &Privacy, api: &Api, work: Vec<DeletionWork>) {
        for w in work {
            let Ok(id20) = w.hash.parse() else { continue };
            let id = TorrentIdOrHash::Hash(id20);
            for &fid in &w.pending {
                let Ok(_writing) = privacy.write_guard().await else {
                    return;
                };
                match self.delete_file(api, id, fid).await {
                    Ok(_) | Err(DeleteError::Disk(_)) => {}
                    Err(DeleteError::Checking) => {}
                    Err(DeleteError::LastFile | DeleteError::NoSuchFile) => {
                        // Can't be done: forget the intent.
                        let mut s = self.state.lock().await;
                        if let Some(m) = s.deleted.get_mut(&w.hash) {
                            m.remove(&fid);
                            if m.is_empty() {
                                s.deleted.remove(&w.hash);
                            }
                        }
                        self.save(&s).await;
                    }
                    Err(DeleteError::Api(e)) => {
                        tracing::warn!(info_hash = %w.hash, file = fid, error = %e, "could not finish a file delete; will retry");
                    }
                }
            }
            if w.clean
                && self
                    .cleaned
                    .lock()
                    .expect("BUG: cleaned lock poisoned")
                    .insert(w.hash.clone())
            {
                let Ok(h) = api.mgr_handle(id) else { continue };
                let Ok(files) = h.with_metadata(|m| m.file_infos.clone()) else {
                    continue;
                };
                let included: Vec<usize> =
                    h.only_files().unwrap_or_else(|| (0..files.len()).collect());
                let root = h.output_folder().to_path_buf();
                let rels: Vec<_> = w
                    .done
                    .iter()
                    .filter(|&&fid| {
                        !included.contains(&fid)
                            && !filedelete::shares_selected_piece(&files, fid, &included)
                    })
                    .filter_map(|&fid| files.get(fid).map(|f| f.relative_filename.clone()))
                    .collect();
                let hash = w.hash.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    for rel in rels {
                        if let Err(e) = filedelete::remove_placeholder(&root, &rel) {
                            tracing::debug!(info_hash = %hash, error = %e, "left a placeholder");
                        }
                    }
                })
                .await;
            }
            // Not while a pending delete still has to finish: the fetched
            // piece would land in a path that is about to be truncated.
            if w.repair && w.pending.is_empty() && privacy.can_add() {
                let Ok(_writing) = privacy.write_guard().await else {
                    return;
                };
                // Re-checked under the lock: the user may have acted since.
                let mut s = self.state.lock().await;
                let Ok(h) = api.mgr_handle(id) else { continue };
                let st = h.stats();
                let e = s.torrents.get(&w.hash).cloned().unwrap_or_default();
                if !needs_repair(
                    matches!(st.state, TorrentStatsState::Paused),
                    st.finished,
                    e.stopped_by_rule,
                    s.recheck_pending.contains_key(&w.hash),
                ) {
                    continue;
                }
                match api.api_torrent_action_start(id).await {
                    Ok(_) => {
                        if let Some(e) = s.torrents.get_mut(&w.hash) {
                            e.repairing = true;
                        }
                        self.save(&s).await;
                        tracing::info!(info_hash = %w.hash, "fetching pieces lost after a file delete")
                    }
                    Err(err) => {
                        tracing::warn!(info_hash = %w.hash, error = %err, "could not restart to fetch lost pieces; will retry")
                    }
                }
            }
        }
    }

    /// One enforcer pass. Every stats read happens under the seeding lock
    /// (an older reading recorded after a newer one would look like a
    /// counter reset and be counted twice), and only for torrents that
    /// still exist (a deleted hash is never recreated).
    async fn pass(&self, privacy: &Privacy, api: &Api, last_save: &mut std::time::Instant) {
        let ids: Vec<usize> = api
            .api_torrent_list_ext(ApiTorrentListOpts { with_stats: false })
            .torrents
            .iter()
            .filter_map(|t| t.id)
            .collect();
        let (policy, _) = self.policy();
        let now = unix_now();
        let mut candidates = Vec::new();
        let mut work = Vec::new();
        {
            let mut s = self.state.lock().await;
            let mut dirty = false;
            let mut urgent = false;
            for id in ids {
                let Ok(h) = api.mgr_handle(TorrentIdOrHash::Id(id)) else {
                    continue;
                };
                let hash = h.shared().info_hash.as_string();
                let st = h.stats();
                let e = s.torrents.entry(hash.clone()).or_default();
                let before = e.clone();
                e.account(&self.boot, live_uploaded(&st));
                if st.finished && e.finished_at.is_none() {
                    e.finished_at = Some(now);
                    // Must survive a crash: it's what closes the seeding
                    // window after the next start.
                    urgent = true;
                }
                if e.repairing && st.finished && matches!(st.state, TorrentStatsState::Live) {
                    // Repaired. Under Forever or Seed nothing pauses it, so
                    // clear the flag here; it must not skip a later startup
                    // pause.
                    e.repairing = false;
                    urgent = true;
                }
                dirty |= *e != before;
                let initializing = matches!(st.state, TorrentStatsState::Initializing { .. });
                if !initializing
                    && s.recheck_pending
                        .get(&hash)
                        .is_some_and(|b| *b != self.boot)
                {
                    // That start's recheck is over.
                    s.recheck_pending.remove(&hash);
                    dirty = true;
                }
                let recheck = s.recheck_pending.contains_key(&hash);
                if let Some(m) = s.deleted.get(&hash)
                    && !initializing
                {
                    let stopped = s.torrents.get(&hash).is_some_and(|e| e.stopped_by_rule);
                    work.push(DeletionWork {
                        hash: hash.clone(),
                        pending: m
                            .iter()
                            .filter(|(_, d)| **d == Deletion::Pending)
                            .map(|(f, _)| *f)
                            .collect(),
                        done: m
                            .iter()
                            .filter(|(_, d)| **d == Deletion::Done)
                            .map(|(f, _)| *f)
                            .collect(),
                        // Once it is Paused or Live: an errored transfer
                        // re-inits (and recreates placeholders) when started.
                        clean: matches!(
                            st.state,
                            TorrentStatsState::Paused | TorrentStatsState::Live
                        ),
                        repair: needs_repair(
                            matches!(st.state, TorrentStatsState::Paused),
                            st.finished,
                            stopped,
                            recheck,
                        ),
                    });
                }
                let keep = s.keep_seeding.contains(&hash);
                if decide(
                    policy,
                    keep,
                    &s.torrents[&hash],
                    &view_of(&st, recheck),
                    now,
                ) == Verdict::Pause
                {
                    candidates.push(hash);
                }
            }
            if urgent || (dirty && last_save.elapsed() >= SAVE_EVERY) {
                self.save(&s).await;
                *last_save = std::time::Instant::now();
            }
        }
        for hash in candidates {
            // Restarting: writes are refused; try again next pass, quietly.
            let Ok(_writing) = privacy.write_guard().await else {
                return;
            };
            let Ok(id20) = hash.parse() else { continue };
            let id = TorrentIdOrHash::Hash(id20);
            let mut s = self.state.lock().await;
            let Ok(h) = api.mgr_handle(id) else { continue };
            let st = h.stats();
            let (policy, _) = self.policy();
            let keep = s.keep_seeding.contains(&hash);
            let recheck = s.recheck_pending.contains_key(&hash);
            let e = s.torrents.entry(hash.clone()).or_default();
            e.account(&self.boot, live_uploaded(&st));
            if decide(policy, keep, e, &view_of(&st, recheck), unix_now()) != Verdict::Pause {
                continue;
            }
            let uploaded = e.uploaded();
            let paused = match api.api_torrent_action_pause(id).await {
                Ok(_) => true,
                Err(_) if is_paused(api, id) => true,
                Err(err) => {
                    tracing::warn!(info_hash = %hash, error = %err, "could not stop seeding; will retry");
                    false
                }
            };
            if paused {
                // Only marked once the pause actually happened.
                if let Some(e) = s.torrents.get_mut(&hash) {
                    e.stopped_by_rule = true;
                    e.repairing = false;
                }
                tracing::info!(name = ?h.name(), info_hash = %hash, uploaded, reason = ?policy, "stopped seeding");
            }
            self.save(&s).await;
            *last_save = std::time::Instant::now();
        }
        self.tend_deletions(privacy, api, work).await;
    }
}

/// One transfer's file-deletion chores for this pass.
struct DeletionWork {
    hash: String,
    pending: Vec<usize>,
    done: Vec<usize>,
    clean: bool,
    repair: bool,
}

/// Enforcer task: a pass at once (the session has just resumed torrents),
/// then every TICK. Holds no lock between passes.
pub async fn enforce(seeding: Arc<Seeding>, privacy: Arc<Privacy>, api: Arc<Api>) {
    let mut last_save = std::time::Instant::now();
    loop {
        seeding.pass(&privacy, &api, &mut last_save).await;
        tokio::time::sleep(TICK).await;
    }
}

/// The value read from settings.json's `seeding`, validated after loading:
/// a bad value falls back to the default without touching other settings.
pub fn policy_from_file(v: Option<&serde_json::Value>) -> Option<Policy> {
    let v = v?;
    match serde_json::from_value::<Policy>(v.clone())
        .map_err(|e| e.to_string())
        .and_then(Policy::validate)
    {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!(error = %e, "ignoring invalid seeding setting; using the default");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_parsing() {
        assert_eq!(Policy::parse(" Stop ").unwrap(), Policy::Stop);
        assert_eq!(Policy::parse("forever").unwrap(), Policy::Forever);
        assert_eq!(
            Policy::parse("ratio:1.5").unwrap(),
            Policy::Ratio { ratio: 1.5 }
        );
        assert_eq!(
            Policy::parse("time:90m").unwrap(),
            Policy::Time { minutes: 90 }
        );
        assert_eq!(
            Policy::parse("time:24h").unwrap(),
            Policy::Time { minutes: 1440 }
        );
        assert_eq!(
            Policy::parse("TIME:7d").unwrap(),
            Policy::Time { minutes: 7 * 1440 }
        );
        for bad in [
            "",
            "ratio:",
            "ratio:nan",
            "ratio:inf",
            "ratio:0",
            "ratio:101",
            "time:0m",
            "time:1.5h",
            "time:366d",
            "time:5",
            "time:5s",
            "seed",
            "time:99999999999d",
        ] {
            assert!(Policy::parse(bad).is_err(), "{bad:?}");
        }
        // Non-ASCII must be an error, never a panic (byte slicing).
        for bad in ["time:5é", "time:é", "time:５m", "ratio:１", "time:+5m"] {
            assert!(Policy::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn file_value_is_lenient() {
        let ok = serde_json::json!({"mode": "ratio", "ratio": 2.0});
        assert_eq!(
            policy_from_file(Some(&ok)),
            Some(Policy::Ratio { ratio: 2.0 })
        );
        assert_eq!(
            policy_from_file(Some(&serde_json::json!({"mode": "ratio", "ratio": 500.0}))),
            None
        );
        assert_eq!(
            policy_from_file(Some(&serde_json::json!({"mode": "weird"}))),
            None
        );
        assert_eq!(policy_from_file(Some(&serde_json::json!("stop"))), None);
        assert_eq!(policy_from_file(None), None);
        assert_eq!(
            serde_json::to_value(Policy::Time { minutes: 60 }).unwrap(),
            serde_json::json!({"mode": "time", "minutes": 60})
        );
    }

    #[test]
    fn upload_accounting_survives_resets_and_restarts() {
        let mut e = Entry::default();
        e.account("a", Some(100));
        e.account("a", Some(250));
        assert_eq!(e.uploaded(), 250);
        // Paused: the live counter is gone; keep what we had.
        e.account("a", None);
        assert_eq!(e.uploaded(), 250);
        // Pause then start inside one tick: counter restarted and already
        // passed the old value. The boot is the same, but it went through
        // "not live" above, so nothing is lost.
        e.account("a", Some(300));
        assert_eq!(e.uploaded(), 550);
        // Restart (new boot) where the new session already passed the old
        // value before the first tick: folded by boot id.
        e.account("b", Some(400));
        assert_eq!(e.uploaded(), 950);
        // Counter went backwards in the same boot.
        e.account("b", Some(10));
        assert_eq!(e.uploaded(), 960);
    }

    fn entry(uploaded: u64, finished_at: Option<u64>) -> Entry {
        Entry {
            finished_at,
            uploaded_base_bytes: uploaded,
            ..Default::default()
        }
    }

    fn view(finished: bool, live: bool, starting: bool) -> View {
        View {
            finished,
            live,
            starting,
            total_bytes: 1000,
            recheck_pending: false,
        }
    }

    #[test]
    fn recheck_is_never_aborted() {
        let now = 10_000;
        let starting = view(false, false, true);
        assert_eq!(
            decide(Policy::Stop, false, &entry(0, Some(now)), &starting, now),
            Verdict::Pause,
            "known finished: paused before it announces"
        );
        let rechecking = View {
            recheck_pending: true,
            ..view(false, false, true)
        };
        assert_eq!(
            decide(Policy::Stop, false, &entry(0, Some(now)), &rechecking, now),
            Verdict::Leave,
            "a file was deleted: let the recheck finish"
        );
        // Restarted by stash to fetch lost pieces (rule-stopped): not paused
        // at the next start before it knows whether it finished.
        let repairing = Entry {
            stopped_by_rule: true,
            repairing: true,
            ..entry(0, Some(now))
        };
        assert_eq!(
            decide(Policy::Stop, false, &repairing, &starting, now),
            Verdict::Leave
        );
        // Rule-stopped but not repairing (its paused flag wasn't saved):
        // still paused before it can announce.
        let rule_stopped = Entry {
            stopped_by_rule: true,
            ..entry(0, Some(now))
        };
        assert_eq!(
            decide(Policy::Stop, false, &rule_stopped, &starting, now),
            Verdict::Pause
        );
        // Once it is live and finished again, the rule applies as usual.
        let live_done = View {
            recheck_pending: true,
            ..view(true, true, false)
        };
        assert_eq!(
            decide(Policy::Stop, false, &entry(0, Some(now)), &live_done, now),
            Verdict::Pause
        );
    }

    #[test]
    fn repair_only_rule_stopped() {
        assert!(needs_repair(true, false, true, false));
        assert!(!needs_repair(true, false, false, false), "user paused");
        assert!(!needs_repair(true, true, true, false), "finished");
        assert!(!needs_repair(false, false, true, false), "live");
        assert!(!needs_repair(true, false, true, true), "recheck pending");
    }

    #[test]
    fn delete_plan() {
        use librqbit::{FileDetailsAttrs, file_info::FileInfo};
        let fi = |padding: bool, hidden: bool| FileInfo {
            relative_filename: PathBuf::from("x"),
            offset_in_torrent: 0,
            piece_range: 0..1,
            attrs: FileDetailsAttrs {
                padding,
                hidden,
                ..Default::default()
            },
            len: 1,
        };
        // 0, 1 visible; 2 padding; 3 hidden.
        let files = [
            fi(false, false),
            fi(false, false),
            fi(true, false),
            fi(false, true),
        ];
        let all = [0, 1, 2, 3];
        assert_eq!(
            plan_delete(&files, &all, 0, false).unwrap(),
            DeleteStep::Deselect
        );
        // already deleted: never touched again; pending: finish the disk step
        assert_eq!(
            plan_delete(&files, &[1, 2, 3], 0, false).unwrap(),
            DeleteStep::Nothing
        );
        assert_eq!(
            plan_delete(&files, &[1, 2, 3], 0, true).unwrap(),
            DeleteStep::Recover
        );
        // the last visible file (padding and hidden don't count)
        assert!(matches!(
            plan_delete(&files, &[1, 2, 3], 1, false),
            Err(DeleteError::LastFile)
        ));
        assert!(matches!(
            plan_delete(&files, &all, 2, false),
            Err(DeleteError::NoSuchFile)
        ));
        assert!(matches!(
            plan_delete(&files, &all, 9, false),
            Err(DeleteError::NoSuchFile)
        ));
    }

    #[test]
    fn deletions_round_trip() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("seeding.json");
        // A file from before this feature loads.
        std::fs::write(&p, br#"{"keep_seeding":[],"torrents":{}}"#).unwrap();
        assert_eq!(SeedState::load(&p), SeedState::default());
        let mut s = SeedState::default();
        s.deleted
            .entry("h".into())
            .or_default()
            .insert(3, Deletion::Pending);
        s.recheck_pending.insert("h".into(), "boot".into());
        s.save(&p).unwrap();
        assert_eq!(SeedState::load(&p), s);
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains(r#""3": "pending""#), "{raw}");
    }

    #[test]
    fn decision_table() {
        use Verdict::*;
        let now = 10_000;
        let live_done = view(true, true, false);
        assert_eq!(
            decide(Policy::Stop, false, &entry(0, Some(now)), &live_done, now),
            Pause
        );
        assert_eq!(
            decide(Policy::Stop, true, &entry(0, Some(now)), &live_done, now),
            Leave,
            "kept"
        );
        assert_eq!(
            decide(
                Policy::Forever,
                false,
                &entry(0, Some(now)),
                &live_done,
                now
            ),
            Leave
        );
        assert_eq!(
            decide(
                Policy::Stop,
                false,
                &entry(0, None),
                &view(false, true, false),
                now
            ),
            Leave,
            "downloading"
        );
        assert_eq!(
            decide(
                Policy::Stop,
                false,
                &entry(0, Some(now)),
                &view(true, false, false),
                now
            ),
            Leave,
            "already paused"
        );
        let r = Policy::Ratio { ratio: 1.5 };
        assert_eq!(
            decide(r, false, &entry(1499, Some(now)), &live_done, now),
            Leave
        );
        assert_eq!(
            decide(r, false, &entry(1500, Some(now)), &live_done, now),
            Pause
        );
        assert_eq!(
            decide(
                r,
                false,
                &entry(0, Some(now)),
                &View {
                    total_bytes: 0,
                    ..live_done
                },
                now
            ),
            Pause
        );
        let t = Policy::Time { minutes: 60 };
        assert_eq!(
            decide(t, false, &entry(0, Some(now - 3599)), &live_done, now),
            Leave
        );
        assert_eq!(
            decide(t, false, &entry(0, Some(now - 3600)), &live_done, now),
            Pause
        );
        // Clock went backwards: never underflows, just not yet.
        assert_eq!(
            decide(t, false, &entry(0, Some(now + 50)), &live_done, now),
            Leave
        );
        // Initializing after a restart: known-finished → pause before it goes live.
        assert_eq!(
            decide(
                Policy::Stop,
                false,
                &entry(0, Some(1)),
                &view(false, false, true),
                now
            ),
            Pause
        );
        assert_eq!(
            decide(
                Policy::Stop,
                false,
                &entry(0, None),
                &view(false, false, true),
                now
            ),
            Leave
        );
    }

    #[test]
    fn keep_override_cannot_bypass_limits() {
        // on_user_start adds to keep only when done(); check the predicate it uses.
        let r = Policy::Ratio { ratio: 2.0 };
        assert!(
            !done(r, &entry(100, Some(1)), 1000, 10),
            "ratio not met: no override"
        );
        assert!(
            done(r, &entry(2000, Some(1)), 1000, 10),
            "ratio met: override allowed"
        );
        let t = Policy::Time { minutes: 10 };
        assert!(
            !done(t, &entry(0, Some(100)), 1000, 200),
            "time not up: no override"
        );
    }

    #[test]
    fn state_round_trip_and_bad_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("seeding.json");
        let mut s = SeedState::default();
        s.keep_seeding.insert("aa".into());
        s.torrents.insert("aa".into(), entry(5, Some(7)));
        s.save(&p).unwrap();
        assert_eq!(SeedState::load(&p), s);
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(SeedState::load(&p), SeedState::default());
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("seeding.json.bad-")
            });
        assert!(kept, "bad file kept aside");
    }
}
