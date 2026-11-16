//! Seeding policy: stop sharing a transfer once it has finished (default),
//! or after a ratio or a time, or never.
//!
//! librqbit's `uploaded_bytes` only counts while a torrent is live and
//! resets on every pause, restart and re-exec, so stash keeps its own
//! cumulative counter per info-hash in `<state>/seeding.json`.
//!
//! Lock order everywhere: the privacy write gate, then the seeding lock.

use std::{
    collections::{BTreeMap, BTreeSet},
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

use crate::privacy::{From_, Privacy};

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
}

pub fn decide(policy: Policy, keep: bool, e: &Entry, v: &View, now: u64) -> Verdict {
    if keep || policy == Policy::Forever {
        return Verdict::Leave;
    }
    // While initializing, `finished` is not known yet; a torrent stash has
    // already seen finished is paused before it can announce as a seeder.
    let finished = v.finished || (v.starting && e.finished_at.is_some());
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

fn view_of(st: &librqbit::TorrentStats) -> View {
    View {
        finished: st.finished,
        live: matches!(st.state, TorrentStatsState::Live),
        starting: matches!(st.state, TorrentStatsState::Initializing { paused: false }),
        total_bytes: st.total_bytes,
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
        if a || b {
            self.save(&s).await;
        }
        Ok(resp)
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
                dirty |= *e != before;
                let keep = s.keep_seeding.contains(&hash);
                if decide(policy, keep, &s.torrents[&hash], &view_of(&st), now) == Verdict::Pause {
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
            let e = s.torrents.entry(hash.clone()).or_default();
            e.account(&self.boot, live_uploaded(&st));
            if decide(policy, keep, e, &view_of(&st), unix_now()) != Verdict::Pause {
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
                }
                tracing::info!(name = ?h.name(), info_hash = %hash, uploaded, reason = ?policy, "stopped seeding");
            }
            self.save(&s).await;
            *last_save = std::time::Instant::now();
        }
    }
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
        }
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
