//! Kill switch, peer blocklist and the settings behind them.
//!
//! librqbit binds its sockets to an interface *index* once, when the session
//! starts. VPN apps make a new tunnel (`utun6`, `utun7`, …) on every
//! reconnect, so a binding goes stale. stash therefore:
//! - picks the binding before the session starts (tunnel, loopback, or none),
//! - watches the route every few seconds,
//! - **stops** the session at once when the binding is no longer right
//!   (never delayed: a reused index could point at Wi-Fi),
//! - and **re-executes itself** once the new state is steady. Re-exec closes
//!   every socket (they are all CLOEXEC), which an in-process rebuild of a
//!   librqbit session cannot guarantee.

use std::{
    ffi::{CStr, CString},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use librqbit::{
    Api, DhtSessionConfig, ListenerMode, ListenerOptions, SessionOptions, SessionPersistenceConfig,
    dht::DhtPersistenceConfig,
};
use serde::{Deserialize, Serialize};

use crate::network;

pub const DEFAULT_BLOCKLIST: &str =
    "https://raw.githubusercontent.com/Naunter/BT_BlockLists/master/bt_blocklists.gz";
const BLOCKLIST_MAX_BYTES: usize = 64 * 1024 * 1024;
const BLOCKLIST_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const TICK: Duration = Duration::from_secs(3);
const STABLE_TICKS: u8 = 2;
const FLAP_GUARD: Duration = Duration::from_secs(30);

// ---------- settings ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// No tunnel: no P2P at all.
    Strict,
    /// No tunnel: torrents run on the normal connection, with a warning.
    Warn,
    /// Never bind (e.g. a VPN on the router).
    Off,
}

/// The kill switch configuration: a level, and optionally one interface
/// that is the only one accepted as the VPN.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VpnMode {
    pub level: Level,
    pub interface: Option<String>,
}

impl VpnMode {
    /// `STASH_VPN`: `strict` | `warn` | `off` | an interface name (strict,
    /// that interface only).
    pub fn parse(v: &str) -> anyhow::Result<Self> {
        let v = v.trim();
        let level = match v.to_ascii_lowercase().as_str() {
            "strict" | "on" | "auto" => Level::Strict,
            "warn" => Level::Warn,
            "off" => Level::Off,
            _ => {
                anyhow::ensure!(
                    !v.is_empty()
                        && v.len() < 16
                        && v.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
                    "STASH_VPN must be strict, warn, off or an interface name (got {v:?})"
                );
                return Ok(Self {
                    level: Level::Strict,
                    interface: Some(v.to_string()),
                });
            }
        };
        Ok(Self {
            level,
            interface: None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum From_ {
    Env,
    File,
    Default,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SettingsFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vpn: Option<Level>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocklist: Option<bool>,
    /// Kept raw and validated after loading, so a bad value here can't
    /// reset the other settings (serde would reject the whole file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeding: Option<serde_json::Value>,
}

impl SettingsFile {
    pub fn load(path: &Path) -> Self {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!(path = %path.display(), error = %e, "ignoring unreadable settings file");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Atomic: write a temp file, fsync it, rename over the old one.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let tmp = path.with_extension("json.tmp");
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(self)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// Where the blocklist comes from: off, a URL, or a local file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlocklistSource {
    Off,
    Url(String),
    File(PathBuf),
}

impl BlocklistSource {
    /// `STASH_BLOCKLIST`: `off` | `on` (default list) | URL | path.
    pub fn parse(v: &str) -> Self {
        let v = v.trim();
        match v.to_ascii_lowercase().as_str() {
            "off" | "0" | "false" | "no" | "" => Self::Off,
            "on" | "1" | "true" | "yes" => Self::Url(DEFAULT_BLOCKLIST.into()),
            _ if v.starts_with("http://") || v.starts_with("https://") => Self::Url(v.into()),
            _ => Self::File(PathBuf::from(v)),
        }
    }

    /// Display/log form: URLs lose any user, password, query and fragment
    /// (a private list URL can carry a token).
    fn label(&self) -> Option<String> {
        match self {
            Self::Off => None,
            Self::Url(u) => Some(redact_url(u)),
            Self::File(p) => Some(p.display().to_string()),
        }
    }
}

pub fn redact_url(u: &str) -> String {
    match reqwest::Url::parse(u) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "(invalid URL)".into(),
    }
}

/// The effective settings and where each came from.
#[derive(Clone, Debug)]
pub struct Settings {
    pub vpn: VpnMode,
    pub vpn_from: From_,
    pub blocklist: BlocklistSource,
    pub blocklist_from: From_,
    pub listen_port: Option<u16>,
    pub upnp: bool,
    pub peer_limit: Option<usize>,
    pub seeding: crate::seeding::Policy,
    pub seeding_from: From_,
}

impl Settings {
    /// Env wins over the settings file, which wins over the defaults.
    pub fn resolve(
        env: &dyn Fn(&str) -> Option<String>,
        file: &SettingsFile,
    ) -> anyhow::Result<Self> {
        let (vpn, vpn_from) = match env("STASH_VPN") {
            Some(v) => (VpnMode::parse(&v)?, From_::Env),
            None => match file.vpn {
                Some(level) => (
                    VpnMode {
                        level,
                        interface: None,
                    },
                    From_::File,
                ),
                None => (
                    VpnMode {
                        level: Level::Strict,
                        interface: None,
                    },
                    From_::Default,
                ),
            },
        };
        let (blocklist, blocklist_from) = match env("STASH_BLOCKLIST") {
            Some(v) => (BlocklistSource::parse(&v), From_::Env),
            None => match file.blocklist {
                Some(true) => (BlocklistSource::Url(DEFAULT_BLOCKLIST.into()), From_::File),
                Some(false) => (BlocklistSource::Off, From_::File),
                None => (
                    BlocklistSource::Url(DEFAULT_BLOCKLIST.into()),
                    From_::Default,
                ),
            },
        };
        let listen_port =
            match env("STASH_LISTEN_PORT") {
                Some(v) => Some(v.trim().parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(
                    || anyhow::anyhow!("STASH_LISTEN_PORT must be 1-65535 (got {v:?})"),
                )?),
                None => None,
            };
        let upnp = match env("STASH_UPNP").map(|v| v.trim().to_ascii_lowercase()) {
            None => false,
            Some(v) if ["on", "1", "true", "yes"].contains(&v.as_str()) => true,
            Some(v) if ["off", "0", "false", "no", ""].contains(&v.as_str()) => false,
            Some(v) => anyhow::bail!("STASH_UPNP must be on or off (got {v:?})"),
        };
        let peer_limit = match env("STASH_PEER_LIMIT") {
            Some(v) => Some(
                v.trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| {
                        anyhow::anyhow!("STASH_PEER_LIMIT must be a positive number (got {v:?})")
                    })?,
            ),
            None => None,
        };
        let (seeding, seeding_from) = match env("STASH_SEEDING") {
            Some(v) => (crate::seeding::Policy::parse(&v)?, From_::Env),
            None => match crate::seeding::policy_from_file(file.seeding.as_ref()) {
                Some(p) => (p, From_::File),
                None => (crate::seeding::Policy::Stop, From_::Default),
            },
        };
        Ok(Self {
            seeding,
            seeding_from,
            vpn,
            vpn_from,
            blocklist,
            blocklist_from,
            listen_port,
            upnp,
            peer_limit,
        })
    }
}

// ---------- binding ----------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Binding {
    /// Torrent traffic only on this interface.
    Bound { name: String, index: u32 },
    /// No networking at all (no VPN under `strict`).
    Blocked,
    /// Not bound (`off`, or no VPN under `warn`).
    Unbound,
}

/// Interface name prefixes accepted as a VPN for the kill switch. Unlike the
/// status display, "no hardware address" is not enough here: fail closed.
pub fn is_vpn_name(name: &str) -> bool {
    const NAMES: [&str; 9] = [
        "utun",
        "tun",
        "wg",
        "tailscale",
        "nordlynx",
        "proton",
        "ipsec",
        "gpd",
        "zt",
    ];
    NAMES.iter().any(|p| name.starts_with(p))
}

/// The route general traffic takes right now: interface name, and whether
/// both probe targets agree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteNow {
    pub iface: Option<String>,
    pub consistent: bool,
}

pub fn desired_binding(
    mode: &VpnMode,
    route: Option<&RouteNow>,
    index_of: &dyn Fn(&str) -> Option<u32>,
) -> Binding {
    if mode.level == Level::Off {
        return Binding::Unbound;
    }
    let accepted = route
        .filter(|r| r.consistent)
        .and_then(|r| r.iface.as_deref())
        .filter(|name| match &mode.interface {
            Some(want) => name == want,
            None => is_vpn_name(name),
        });
    if let Some(name) = accepted
        && let Some(index) = index_of(name)
    {
        return Binding::Bound {
            name: name.to_string(),
            index,
        };
    }
    match mode.level {
        Level::Warn => Binding::Unbound,
        _ => Binding::Blocked,
    }
}

pub fn if_index(name: &str) -> Option<u32> {
    let c = CString::new(name).ok()?;
    // SAFETY: `c` is a valid NUL-terminated string for the call's duration.
    let i = unsafe { libc::if_nametoindex(c.as_ptr()) };
    (i != 0).then_some(i)
}

pub fn if_name(index: u32) -> Option<String> {
    let mut buf = [0 as libc::c_char; libc::IF_NAMESIZE];
    // SAFETY: `buf` has IF_NAMESIZE bytes, as if_indextoname requires; on
    // success it holds a NUL-terminated name.
    let p = unsafe { libc::if_indextoname(index, buf.as_mut_ptr()) };
    if p.is_null() {
        return None;
    }
    // SAFETY: if_indextoname returned `buf`, which is NUL-terminated.
    Some(
        unsafe { CStr::from_ptr(buf.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn loopback_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "lo0"
    } else {
        "lo"
    }
}

pub fn route_now() -> Option<RouteNow> {
    network::v4_route_iface().map(|(iface, consistent)| RouteNow { iface, consistent })
}

// ---------- supervisor decisions (pure) ----------

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    /// Stop all torrent traffic now.
    Stop,
    /// Re-execute stash so the new binding takes effect.
    Restart,
}

#[derive(Debug)]
pub struct Machine {
    pub current: Binding,
    pub stopped: bool,
    pending: Option<(Binding, u8)>,
    started: Instant,
    /// A binding this process tried and could not start (it fell back to
    /// Blocked). Desiring it again is not a reason to restart: that would
    /// loop forever. Only a new name or index is.
    failed: Option<Binding>,
}

impl Machine {
    pub fn new(current: Binding, started: Instant, failed: Option<Binding>) -> Self {
        Self {
            current,
            stopped: false,
            pending: None,
            started,
            failed,
        }
    }

    /// One supervisor tick. `live_name` is `if_indextoname(index)` of the
    /// bound interface right now (None when unbound or the index is gone).
    pub fn tick(&mut self, desired: &Binding, live_name: Option<&str>, now: Instant) -> Action {
        let dead = match &self.current {
            Binding::Bound { name, .. } => live_name != Some(name.as_str()),
            _ => false,
        };
        let same_failure = self.failed.as_ref() == Some(desired);
        let differs = dead || (*desired != self.current && !same_failure);
        if !differs && !self.stopped {
            self.pending = None;
            return Action::None;
        }
        // A bound session whose binding is no longer right stops at once.
        if matches!(self.current, Binding::Bound { .. }) && !self.stopped {
            self.stopped = true;
            self.pending = Some((desired.clone(), 1));
            return Action::Stop;
        }
        // Restart once the desired binding has held for STABLE_TICKS.
        let ticks = match &self.pending {
            Some((b, n)) if b == desired => n.saturating_add(1),
            _ => 1,
        };
        self.pending = Some((desired.clone(), ticks));
        if ticks >= STABLE_TICKS && now.saturating_duration_since(self.started) >= FLAP_GUARD {
            Action::Restart
        } else {
            Action::None
        }
    }
}

// ---------- blocklist cache ----------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BlocklistMeta {
    pub source: Option<String>,
    pub updated_at: Option<u64>,
    pub ranges: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BlocklistStatus {
    #[serde(flatten)]
    pub meta: BlocklistMeta,
    /// The list the running session loaded (None: no list in use).
    pub in_use: bool,
    pub fetching: bool,
    pub error: Option<String>,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Largest list stash accepts once decompressed (the default list is
/// ~50 MB). Guards against gzip bombs, here and in librqbit's own loader,
/// which only ever sees lists that passed this check.
const BLOCKLIST_MAX_DECOMPRESSED: u64 = 512 * 1024 * 1024;
const BLOCKLIST_MAX_LINE: usize = 4096;

/// Parses a P2P-format list (`name:start-end`, plain or gzip) and returns it
/// normalised: one `r:start-end` line per valid range, plain UTF-8. librqbit
/// errors out on any non-UTF-8 byte (and stash would then fail to start), so
/// it only ever sees this output. Fails on a list that decompresses past the
/// cap or has an absurdly long line.
pub fn normalize_ranges(bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    normalize_ranges_capped(bytes, BLOCKLIST_MAX_DECOMPRESSED)
}

/// Same split rule as librqbit's `parse_ip_range`.
fn parse_range(line: &str) -> Option<(std::net::IpAddr, std::net::IpAddr)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (_, ips) = if line.matches(':').count() > 2 {
        line.split_once(':')?
    } else {
        line.rsplit_once(':')?
    };
    let (a, b) = ips.split_once('-')?;
    let (a, b): (std::net::IpAddr, std::net::IpAddr) =
        (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (a.is_ipv4() == b.is_ipv4()).then_some((a, b))
}

fn normalize_ranges_capped(bytes: &[u8], cap: u64) -> Result<(Vec<u8>, usize), String> {
    use std::io::{BufRead, BufReader, Read};
    let raw: Box<dyn Read + '_> = if bytes.starts_with(&[0x1f, 0x8b]) {
        Box::new(flate2::read::GzDecoder::new(bytes))
    } else {
        Box::new(bytes)
    };
    // One byte over the cap tells "too large" apart from "exactly the cap".
    let mut reader = BufReader::new(raw.take(cap + 1));
    let (mut total, mut count) = (0u64, 0usize);
    let mut out = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = (&mut reader)
            .take(BLOCKLIST_MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("The blocklist could not be read: {e}"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > cap {
            return Err(format!(
                "The blocklist is larger than {} MB unpacked",
                cap >> 20
            ));
        }
        if n > BLOCKLIST_MAX_LINE && line.last() != Some(&b'\n') {
            return Err("The blocklist has a line longer than 4 KB".into());
        }
        if let Some((a, b)) = parse_range(&String::from_utf8_lossy(&line)) {
            out.extend_from_slice(format!("r:{a}-{b}\n").as_bytes());
            count += 1;
        }
    }
    Ok((out, count))
}

pub struct Blocklist {
    path: PathBuf,
    meta_path: PathBuf,
    status: Mutex<BlocklistStatus>,
}

impl Blocklist {
    pub fn new(state_dir: &Path) -> anyhow::Result<Self> {
        let path = state_dir.join("blocklist");
        let meta_path = state_dir.join("blocklist.json");
        let meta: BlocklistMeta = std::fs::read(&meta_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Ok(Self {
            path,
            meta_path,
            status: Mutex::new(BlocklistStatus {
                meta,
                ..Default::default()
            }),
        })
    }

    pub fn status(&self) -> BlocklistStatus {
        self.status.lock().unwrap().clone()
    }

    /// `file://` URL of the cached list for librqbit, if it exists and came
    /// from `source`. Built from an absolute path: librqbit rejects relative
    /// file URLs.
    pub fn file_url_for(&self, source: &BlocklistSource) -> Option<String> {
        let label = source.label()?;
        if self.status.lock().unwrap().meta.source.as_deref() != Some(label.as_str()) {
            return None;
        }
        self.file_url()
    }

    pub fn file_url(&self) -> Option<String> {
        let abs = self.path.canonicalize().ok()?;
        reqwest::Url::from_file_path(abs).ok().map(String::from)
    }

    pub fn mark_in_use(&self, in_use: bool) {
        self.status.lock().unwrap().in_use = in_use;
    }

    fn stale(&self, source: &str) -> bool {
        let s = self.status.lock().unwrap();
        s.meta.source.as_deref() != Some(source)
            || s.meta
                .updated_at
                .is_none_or(|t| unix_now().saturating_sub(t) > BLOCKLIST_MAX_AGE.as_secs())
            || !self.path.exists()
    }

    /// Marks a refresh as started. False when one is already running or the
    /// cache is fresh (unless `force`). Callers that answer an HTTP request
    /// call this first, so the response already shows `fetching`.
    pub fn try_begin(&self, source: &BlocklistSource, force: bool) -> bool {
        let Some(label) = source.label() else {
            return false;
        };
        if !force && !self.stale(&label) {
            return false;
        }
        let mut s = self.status.lock().unwrap();
        if s.fetching {
            return false;
        }
        s.fetching = true;
        true
    }

    /// Fetches or copies the list into the cache. `via` binds the download
    /// to the VPN interface; callers never call this while the kill switch
    /// has stopped traffic.
    pub async fn refresh(&self, source: &BlocklistSource, force: bool, via: Option<&str>) {
        if self.try_begin(source, force) {
            self.run(source, via).await;
        }
    }

    /// The download itself; `try_begin` must have returned true.
    pub async fn run(&self, source: &BlocklistSource, via: Option<&str>) {
        let label = source.label().unwrap_or_default();
        let result = match source {
            BlocklistSource::Url(u) => self.download(u, via).await,
            BlocklistSource::File(p) => tokio::fs::read(p)
                .await
                .map_err(|e| format!("Could not read {}: {e}", p.display())),
            BlocklistSource::Off => {
                self.status.lock().unwrap().fetching = false;
                return;
            }
        };
        let outcome = match result {
            Ok(bytes) => self.store(&label, bytes).await,
            Err(e) => Err(e),
        };
        let mut s = self.status.lock().unwrap();
        s.fetching = false;
        match outcome {
            Ok(meta) => {
                tracing::info!(ranges = meta.ranges, source = %label, "blocklist updated");
                s.meta = meta;
                s.error = None;
            }
            Err(e) => {
                tracing::warn!(error = %e, source = %label, "blocklist update failed; keeping the cached copy");
                s.error = Some(e);
            }
        }
    }

    async fn download(&self, url: &str, via: Option<&str>) -> Result<Vec<u8>, String> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60));
        if let Some(iface) = via {
            // Only through the tunnel (macOS IP_BOUND_IF, Linux SO_BINDTODEVICE).
            builder = builder.interface(iface);
        }
        let client = builder
            .build()
            .map_err(|e| format!("Could not set up the download: {}", e.without_url()))?;
        let mut resp = client
            .get(url)
            .send()
            .await
            // without_url: the URL may carry a token; never put it in messages.
            .map_err(|e| format!("Could not download the blocklist: {}", e.without_url()))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Blocklist server answered {}",
                resp.status().as_u16()
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Blocklist download failed: {}", e.without_url()))?
        {
            if body.len() + chunk.len() > BLOCKLIST_MAX_BYTES {
                return Err("Blocklist is larger than 64 MB".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    async fn store(&self, label: &str, bytes: Vec<u8>) -> Result<BlocklistMeta, String> {
        let path = self.path.clone();
        let meta_path = self.meta_path.clone();
        let label = label.to_string();
        tokio::task::spawn_blocking(move || {
            let (bytes, ranges) = normalize_ranges(&bytes)?;
            if ranges == 0 {
                return Err(
                    "The blocklist has no IP ranges in a format stash understands".to_string(),
                );
            }
            let meta = BlocklistMeta {
                source: Some(label),
                updated_at: Some(unix_now()),
                ranges: Some(ranges),
            };
            let write = |p: &Path, data: &[u8]| -> std::io::Result<()> {
                let mut tmp = p.as_os_str().to_owned();
                tmp.push(".tmp");
                let tmp = PathBuf::from(tmp);
                let mut f = std::fs::File::create(&tmp)?;
                f.write_all(data)?;
                f.sync_all()?;
                std::fs::rename(&tmp, p)
            };
            write(&path, &bytes).map_err(|e| format!("Could not save the blocklist: {e}"))?;
            let m = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
            write(&meta_path, &m).map_err(|e| format!("Could not save the blocklist: {e}"))?;
            Ok(meta)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

// ---------- session options ----------

pub struct SessionBase {
    pub session_dir: PathBuf,
    pub state_dir: PathBuf,
}

pub fn session_options(
    base: &SessionBase,
    settings: &Settings,
    binding: &Binding,
    blocklist_url: Option<String>,
) -> SessionOptions {
    let private = settings.vpn.level != Level::Off;
    let mut opts = SessionOptions {
        persistence: Some(SessionPersistenceConfig::Json {
            folder: Some(base.session_dir.clone()),
        }),
        fastresume: true,
        peer_limit: settings.peer_limit,
        ..Default::default()
    };
    if private {
        // LSD multicasts info-hashes on the LAN whatever the VPN does.
        opts.disable_local_service_discovery = true;
        // A DHT node ID seen from both the real and the VPN IP links them,
        // so each kind of route keeps its own identity (and never rqbit's
        // shared cache).
        let file = match binding {
            Binding::Bound { .. } => "dht-vpn.json",
            _ => "dht-direct.json",
        };
        opts.dht = Some(DhtSessionConfig {
            persistence: Some(DhtPersistenceConfig {
                config_filename: Some(base.state_dir.join(file)),
                ..Default::default()
            }),
            ..Default::default()
        });
    }
    if let Some(port) = settings.listen_port {
        opts.listen = Some(ListenerOptions {
            mode: ListenerMode::TcpAndUtp,
            listen_addr: (std::net::Ipv6Addr::UNSPECIFIED, port).into(),
            announce_port: Some(port),
            // UPnP opens a port on the home router: never with the kill switch.
            enable_upnp_port_forwarding: settings.upnp && !private,
            ..Default::default()
        });
    }
    match binding {
        Binding::Bound { name, .. } => opts.bind_device_name = Some(name.clone()),
        Binding::Unbound => {}
        Binding::Blocked => {
            // No networking at all: no DHT, trackers (and their DNS
            // lookups), LSD or listener; loopback binding as a second layer.
            opts.dht = None;
            opts.disable_trackers = true;
            opts.disable_local_service_discovery = true;
            opts.listen = None;
            opts.bind_device_name = Some(loopback_name().into());
        }
    }
    if !matches!(binding, Binding::Blocked) {
        opts.blocklist_url = blocklist_url;
    }
    opts
}

// ---------- runtime state shared with handlers ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KillState {
    Off,
    Bound,
    Blocked,
    /// Torrents stopped; stash restarts once the new route is steady.
    Reconnecting,
    /// Unbound under `warn`: torrents run on the normal connection.
    Exposed,
    /// stash could not re-execute itself (e.g. the binary was replaced).
    /// Torrents stay stopped until someone restarts stash by hand.
    RestartFailed,
}

/// Why stash is stopped and about to restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestartReason {
    /// The VPN tunnel went away or changed.
    Vpn,
    /// Settings changed, or "Restart to apply".
    Settings,
}

#[derive(Clone, Debug, Serialize)]
pub struct KillSwitchReport {
    pub level: Level,
    pub interface: Option<String>,
    pub level_from: From_,
    pub bound_to: Option<String>,
    pub state: KillState,
    pub restart_reason: Option<RestartReason>,
    pub listen_port: Option<u16>,
    pub accepting_writes: bool,
    /// Changes on every (re)start; the UI waits for a new one after a restart.
    pub boot_id: String,
}

pub struct Privacy {
    pub settings: Settings,
    pub settings_path: PathBuf,
    pub blocklist: Blocklist,
    binding: Mutex<Binding>,
    /// A binding that failed to start in this process (we fell back).
    failed_binding: Option<Binding>,
    boot_id: String,
    stopped: AtomicBool,
    accepting_writes: AtomicBool,
    /// Shown to the UI as soon as a restart is asked for.
    restart_pending: AtomicBool,
    /// Acted on by the supervisor (set a moment later).
    restart_requested: AtomicBool,
    restart_reason: Mutex<Option<RestartReason>>,
    /// exec failed: stay stopped and report Blocked.
    exec_failed: AtomicBool,
    gate: tokio::sync::RwLock<()>,
    notify: tokio::sync::Notify,
    /// Serialises read-modify-write of settings.json.
    settings_lock: tokio::sync::Mutex<()>,
    /// Set once by main after construction (it needs our boot id).
    pub seeding: std::sync::OnceLock<Arc<crate::seeding::Seeding>>,
}

pub struct WriteGuard<'a>(#[allow(dead_code)] tokio::sync::RwLockReadGuard<'a, ()>);

pub struct Unavailable;

impl IntoResponse for Unavailable {
    fn into_response(self) -> Response {
        let mut r = (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "human_readable": "stash is restarting. Try again in a moment."
            })),
        )
            .into_response();
        r.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("3"));
        r
    }
}

impl Privacy {
    pub fn new(
        settings: Settings,
        settings_path: PathBuf,
        blocklist: Blocklist,
        binding: Binding,
        failed_binding: Option<Binding>,
    ) -> Self {
        let boot = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        Self {
            settings,
            settings_path,
            blocklist,
            binding: Mutex::new(binding),
            failed_binding,
            boot_id: format!("{boot:x}"),
            stopped: AtomicBool::new(false),
            accepting_writes: AtomicBool::new(true),
            restart_pending: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
            restart_reason: Mutex::new(None),
            exec_failed: AtomicBool::new(false),
            gate: tokio::sync::RwLock::new(()),
            notify: tokio::sync::Notify::new(),
            settings_lock: tokio::sync::Mutex::new(()),
            seeding: std::sync::OnceLock::new(),
        }
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    /// The interface the blocklist may be downloaded through right now:
    /// Some(Some(tunnel)) when bound, Some(None) when unbound, None when the
    /// kill switch has stopped traffic (no download at all).
    pub fn download_route(&self) -> Option<Option<String>> {
        if self.stopped.load(Ordering::Acquire) {
            return None;
        }
        match self.binding() {
            Binding::Bound { name, .. } => Some(Some(name)),
            Binding::Unbound => Some(None),
            Binding::Blocked => None,
        }
    }

    /// Whether adding transfers can work: not while the kill switch has
    /// stopped all traffic (no peers, and a magnet add would just hang).
    pub fn can_add(&self) -> bool {
        !matches!(self.binding(), Binding::Blocked)
    }

    pub fn binding(&self) -> Binding {
        self.binding.lock().unwrap().clone()
    }

    /// Held by add/start/pause/delete. Fails while the session is stopped.
    pub async fn write_guard(&self) -> Result<WriteGuard<'_>, Unavailable> {
        if !self.accepting_writes.load(Ordering::Acquire) {
            return Err(Unavailable);
        }
        let g = self.gate.read().await;
        if !self.accepting_writes.load(Ordering::Acquire) {
            return Err(Unavailable);
        }
        Ok(WriteGuard(g))
    }

    /// Asks the supervisor to apply new settings (stop, then re-exec).
    pub fn request_restart(&self) {
        self.restart_requested.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    fn set_reason(&self, r: RestartReason) {
        let mut g = self.restart_reason.lock().unwrap();
        if g.is_none() {
            *g = Some(r);
        }
    }

    pub fn report(&self) -> KillSwitchReport {
        let binding = self.binding();
        let level = self.settings.vpn.level;
        let state = if self.exec_failed.load(Ordering::Acquire) {
            KillState::RestartFailed
        } else if self.stopped.load(Ordering::Acquire) {
            KillState::Reconnecting
        } else {
            match (&binding, level) {
                (_, Level::Off) => KillState::Off,
                (Binding::Bound { .. }, _) => KillState::Bound,
                (Binding::Blocked, _) => KillState::Blocked,
                (Binding::Unbound, _) => KillState::Exposed,
            }
        };
        KillSwitchReport {
            level,
            interface: self.settings.vpn.interface.clone(),
            level_from: self.settings.vpn_from,
            bound_to: match &binding {
                Binding::Bound { name, .. } => Some(name.clone()),
                Binding::Blocked => Some(loopback_name().into()),
                Binding::Unbound => None,
            },
            state,
            restart_reason: *self.restart_reason.lock().unwrap(),
            listen_port: self.settings.listen_port,
            accepting_writes: self.accepting_writes.load(Ordering::Acquire),
            boot_id: self.boot_id.clone(),
        }
    }

    async fn stop_session(&self, api: &Api, reason: RestartReason) {
        self.set_reason(reason);
        self.accepting_writes.store(false, Ordering::Release);
        self.stopped.store(true, Ordering::Release);
        // Pauses in memory only (the persisted paused flag is unchanged),
        // drops peers, cancels the session's tasks.
        api.session().stop().await;
        // A start/add that was already running may have revived a torrent;
        // let in-flight writes drain (bounded), then stop again (idempotent).
        let _drained = tokio::time::timeout(Duration::from_secs(5), self.gate.write()).await;
        api.session().stop().await;
    }

    /// Never returns on success.
    async fn reexec(&self) {
        let mut backoff = Duration::from_secs(5);
        loop {
            // Let in-flight writes finish so exec doesn't cut one in half.
            let guard = tokio::time::timeout(Duration::from_secs(5), self.gate.write()).await;
            if let Some(s) = self.seeding.get() {
                s.flush_now();
            }
            let err = exec_self();
            drop(guard);
            self.exec_failed.store(true, Ordering::Release);
            tracing::error!(
                error = %err,
                "could not restart stash; torrents stay stopped. If the binary was replaced, restart stash by hand. Retrying"
            );
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    }
}

fn exec_self() -> std::io::Error {
    use std::os::unix::process::CommandExt;
    match std::env::current_exe() {
        Ok(exe) => {
            tracing::info!(exe = %exe.display(), "restarting stash to apply new network settings");
            std::process::Command::new(exe)
                .args(std::env::args_os().skip(1))
                .exec()
        }
        Err(e) => e,
    }
}

/// Watches the route and drives the kill switch. Also handles settings
/// changes and the daily blocklist refresh.
pub async fn supervise(privacy: Arc<Privacy>, api: Arc<Api>) {
    let mut machine = Machine::new(
        privacy.binding(),
        Instant::now(),
        privacy.failed_binding.clone(),
    );
    let mut last_refresh_check = Instant::now();
    loop {
        tokio::select! {
            () = tokio::time::sleep(TICK) => {}
            () = privacy.notify.notified() => {}
        }

        if privacy.restart_requested.load(Ordering::Acquire) {
            if !privacy.stopped.load(Ordering::Acquire) {
                privacy.stop_session(&api, RestartReason::Settings).await;
            }
            privacy.reexec().await;
        }

        if privacy.settings.vpn.level != Level::Off {
            let current = machine.current.clone();
            let mode = privacy.settings.vpn.clone();
            let (desired, live) = tokio::task::spawn_blocking(move || {
                let desired = desired_binding(&mode, route_now().as_ref(), &if_index);
                let live = match &current {
                    Binding::Bound { index, .. } => if_name(*index),
                    _ => None,
                };
                (desired, live)
            })
            .await
            .unwrap_or((Binding::Blocked, None));
            match machine.tick(&desired, live.as_deref(), Instant::now()) {
                Action::None => {}
                Action::Stop => {
                    tracing::warn!(?desired, "VPN route changed: torrent traffic stopped");
                    privacy.stop_session(&api, RestartReason::Vpn).await;
                }
                Action::Restart => {
                    if !privacy.stopped.load(Ordering::Acquire) {
                        privacy.stop_session(&api, RestartReason::Vpn).await;
                    }
                    privacy.reexec().await;
                }
            }
        }

        // Daily blocklist refresh, never while networking is blocked.
        if last_refresh_check.elapsed() >= Duration::from_secs(600) {
            last_refresh_check = Instant::now();
            if let Some(via) = privacy.download_route() {
                let p = privacy.clone();
                tokio::spawn(async move {
                    p.blocklist
                        .refresh(&p.settings.blocklist, false, via.as_deref())
                        .await
                });
            }
        }
    }
}

// ---------- settings API ----------

#[derive(Serialize)]
pub struct SettingsView {
    pub vpn: Level,
    pub vpn_interface: Option<String>,
    pub vpn_from: From_,
    pub blocklist: bool,
    pub blocklist_source: Option<String>,
    pub blocklist_from: From_,
    pub blocklist_status: BlocklistStatus,
    pub listen_port: Option<u16>,
    pub restart_pending: bool,
    pub boot_id: String,
    pub seeding: crate::seeding::Policy,
    pub seeding_from: From_,
}

pub async fn get_settings(State(p): State<Arc<Privacy>>) -> Response {
    let s = &p.settings;
    let mut r = Json(SettingsView {
        vpn: s.vpn.level,
        vpn_interface: s.vpn.interface.clone(),
        vpn_from: s.vpn_from,
        blocklist: s.blocklist != BlocklistSource::Off,
        blocklist_source: s.blocklist.label(),
        blocklist_from: s.blocklist_from,
        blocklist_status: p.blocklist.status(),
        listen_port: s.listen_port,
        restart_pending: p.restart_pending.load(Ordering::Acquire),
        boot_id: p.boot_id.clone(),
        seeding: p.seeding.get().map_or(s.seeding, |x| x.policy().0),
        seeding_from: p.seeding.get().map_or(s.seeding_from, |x| x.policy().1),
    })
    .into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsUpdate {
    pub vpn: Option<Level>,
    pub blocklist: Option<bool>,
    pub seeding: Option<crate::seeding::Policy>,
}

fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "human_readable": msg }))).into_response()
}

/// Saves the new values and restarts stash so they take effect.
pub async fn put_settings(
    State(p): State<Arc<Privacy>>,
    Json(u): Json<SettingsUpdate>,
) -> Response {
    if u.vpn.is_none() && u.blocklist.is_none() && u.seeding.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "Nothing to change.");
    }
    if u.seeding.is_some() && p.settings.seeding_from == From_::Env {
        return json_error(
            StatusCode::CONFLICT,
            "Seeding is set by STASH_SEEDING. Change it there.",
        );
    }
    let seeding = match u.seeding.map(crate::seeding::Policy::validate) {
        Some(Err(e)) => return json_error(StatusCode::BAD_REQUEST, &format!("Seeding: {e}.")),
        Some(Ok(p)) => Some(p),
        None => None,
    };
    let _one_at_a_time = p.settings_lock.lock().await;
    if u.vpn.is_some() && p.settings.vpn_from == From_::Env {
        return json_error(
            StatusCode::CONFLICT,
            "The kill switch is set by STASH_VPN. Change it there.",
        );
    }
    if u.blocklist.is_some() && p.settings.blocklist_from == From_::Env {
        return json_error(
            StatusCode::CONFLICT,
            "The blocklist is set by STASH_BLOCKLIST. Change it there.",
        );
    }
    let mut file = SettingsFile::load(&p.settings_path);
    if let Some(v) = u.vpn {
        file.vpn = Some(v);
    }
    if let Some(b) = u.blocklist {
        file.blocklist = Some(b);
    }
    if let Some(sp) = seeding {
        file.seeding = serde_json::to_value(sp).ok();
    }
    let path = p.settings_path.clone();
    let saved = tokio::task::spawn_blocking(move || file.save(&path)).await;
    match saved {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::error!(error = %e, "could not save settings");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not save the settings.",
            );
        }
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not save the settings.",
            );
        }
    }
    // Seeding applies live, even when a restart follows.
    if let (Some(sp), Some(seed)) = (seeding, p.seeding.get()) {
        seed.set_policy(sp);
    }
    if u.vpn.is_none() && u.blocklist.is_none() {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "restart": false })),
        )
            .into_response();
    }
    schedule_restart(&p);
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "restart": true })),
    )
        .into_response()
}

/// Marks the restart as pending at once (so the UI never mistakes this
/// process for the restarted one), then acts after a short delay so the
/// response gets out first.
fn schedule_restart(p: &Arc<Privacy>) {
    p.restart_pending.store(true, Ordering::Release);
    p.set_reason(RestartReason::Settings);
    let p = p.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        p.request_restart();
    });
}

pub async fn post_restart(State(p): State<Arc<Privacy>>) -> Response {
    schedule_restart(&p);
    StatusCode::ACCEPTED.into_response()
}

pub async fn post_blocklist_refresh(State(p): State<Arc<Privacy>>) -> Response {
    if p.settings.blocklist == BlocklistSource::Off {
        return json_error(StatusCode::CONFLICT, "The blocklist is off.");
    }
    let Some(via) = p.download_route() else {
        return json_error(
            StatusCode::CONFLICT,
            "The kill switch has stopped all traffic (no VPN), so stash won't download the list now.",
        );
    };
    // Mark it started before answering, so the next GET shows "fetching".
    if !p.blocklist.try_begin(&p.settings.blocklist, true) {
        return StatusCode::ACCEPTED.into_response();
    }
    let q = p.clone();
    tokio::spawn(async move { q.blocklist.run(&q.settings.blocklist, via.as_deref()).await });
    StatusCode::ACCEPTED.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let v: Vec<(String, String)> = pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        move |k| v.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone())
    }

    #[test]
    fn vpn_mode_parsing() {
        assert_eq!(VpnMode::parse("strict").unwrap().level, Level::Strict);
        assert_eq!(VpnMode::parse("AUTO").unwrap().level, Level::Strict);
        assert_eq!(VpnMode::parse("warn").unwrap().level, Level::Warn);
        assert_eq!(VpnMode::parse(" off ").unwrap().level, Level::Off);
        let wg = VpnMode::parse("wg0").unwrap();
        assert_eq!(
            (wg.level, wg.interface.as_deref()),
            (Level::Strict, Some("wg0"))
        );
        assert!(VpnMode::parse("bad name!").is_err());
        assert!(VpnMode::parse("").is_err());
    }

    #[test]
    fn settings_precedence_env_file_default() {
        let none = env_of(&[]);
        let d = Settings::resolve(&none, &SettingsFile::default()).unwrap();
        assert_eq!((d.vpn.level, d.vpn_from), (Level::Strict, From_::Default));
        assert_eq!(d.blocklist, BlocklistSource::Url(DEFAULT_BLOCKLIST.into()));
        assert_eq!(d.blocklist_from, From_::Default);

        let file = SettingsFile {
            vpn: Some(Level::Warn),
            blocklist: Some(false),
            seeding: None,
        };
        let f = Settings::resolve(&none, &file).unwrap();
        assert_eq!(f.seeding, crate::seeding::Policy::Stop);
        assert_eq!(f.seeding_from, From_::Default);

        // A bad seeding value only resets seeding, never vpn/blocklist.
        let bad = SettingsFile {
            vpn: Some(Level::Warn),
            blocklist: Some(false),
            seeding: Some(serde_json::json!({"mode": "ratio", "ratio": 9999.0})),
        };
        let b = Settings::resolve(&none, &bad).unwrap();
        assert_eq!(
            (b.vpn.level, b.seeding),
            (Level::Warn, crate::seeding::Policy::Stop)
        );
        let raw: SettingsFile =
            serde_json::from_str(r#"{"vpn":"off","seeding":{"mode":"nonsense"}}"#).unwrap();
        assert_eq!(raw.vpn, Some(Level::Off));
        let env = env_of(&[("STASH_SEEDING", "ratio:2")]);
        let e = Settings::resolve(&env, &bad).unwrap();
        assert_eq!(
            (e.seeding, e.seeding_from),
            (crate::seeding::Policy::Ratio { ratio: 2.0 }, From_::Env)
        );
        assert_eq!((f.vpn.level, f.vpn_from), (Level::Warn, From_::File));
        assert_eq!(
            (f.blocklist.clone(), f.blocklist_from),
            (BlocklistSource::Off, From_::File)
        );

        let env = env_of(&[("STASH_VPN", "off"), ("STASH_BLOCKLIST", "/tmp/list.p2p")]);
        let e = Settings::resolve(&env, &file).unwrap();
        assert_eq!((e.vpn.level, e.vpn_from), (Level::Off, From_::Env));
        assert_eq!(e.blocklist, BlocklistSource::File("/tmp/list.p2p".into()));
    }

    #[test]
    fn numeric_env_values_are_strict() {
        let ok = env_of(&[
            ("STASH_LISTEN_PORT", "51413"),
            ("STASH_PEER_LIMIT", "80"),
            ("STASH_UPNP", "on"),
        ]);
        let s = Settings::resolve(&ok, &SettingsFile::default()).unwrap();
        assert_eq!(
            (s.listen_port, s.peer_limit, s.upnp),
            (Some(51413), Some(80), true)
        );
        for bad in [
            ("STASH_LISTEN_PORT", "0"),
            ("STASH_LISTEN_PORT", "70000"),
            ("STASH_PEER_LIMIT", "-1"),
            ("STASH_UPNP", "maybe"),
        ] {
            assert!(
                Settings::resolve(&env_of(&[bad]), &SettingsFile::default()).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn blocklist_source_parsing() {
        assert_eq!(BlocklistSource::parse("off"), BlocklistSource::Off);
        assert_eq!(
            BlocklistSource::parse("on"),
            BlocklistSource::Url(DEFAULT_BLOCKLIST.into())
        );
        assert_eq!(
            BlocklistSource::parse("https://x/y.gz"),
            BlocklistSource::Url("https://x/y.gz".into())
        );
        assert_eq!(
            BlocklistSource::parse("lists/a.p2p"),
            BlocklistSource::File("lists/a.p2p".into())
        );
    }

    #[test]
    fn binding_by_level() {
        let idx = |n: &str| (n != "gone0").then_some(7);
        let route = |name: &str, consistent| RouteNow {
            iface: Some(name.into()),
            consistent,
        };
        let strict = VpnMode {
            level: Level::Strict,
            interface: None,
        };
        let warn = VpnMode {
            level: Level::Warn,
            interface: None,
        };
        let off = VpnMode {
            level: Level::Off,
            interface: None,
        };
        let wg = VpnMode {
            level: Level::Strict,
            interface: Some("wg0".into()),
        };
        let bound = |n: &str| Binding::Bound {
            name: n.into(),
            index: 7,
        };

        assert_eq!(
            desired_binding(&strict, Some(&route("utun6", true)), &idx),
            bound("utun6")
        );
        assert_eq!(
            desired_binding(&strict, Some(&route("en0", true)), &idx),
            Binding::Blocked
        );
        assert_eq!(desired_binding(&strict, None, &idx), Binding::Blocked);
        assert_eq!(
            desired_binding(&strict, Some(&route("utun6", false)), &idx),
            Binding::Blocked
        );
        assert_eq!(
            desired_binding(&strict, Some(&route("gone0", true)), &idx),
            Binding::Blocked
        );
        // A MAC-less but unknown name is not trusted by the kill switch.
        assert_eq!(
            desired_binding(&strict, Some(&route("weird0", true)), &idx),
            Binding::Blocked
        );
        assert_eq!(
            desired_binding(&warn, Some(&route("utun6", true)), &idx),
            bound("utun6")
        );
        assert_eq!(
            desired_binding(&warn, Some(&route("en0", true)), &idx),
            Binding::Unbound
        );
        assert_eq!(
            desired_binding(&off, Some(&route("utun6", true)), &idx),
            Binding::Unbound
        );
        assert_eq!(
            desired_binding(&wg, Some(&route("wg0", true)), &idx),
            bound("wg0")
        );
        assert_eq!(
            desired_binding(&wg, Some(&route("utun6", true)), &idx),
            Binding::Blocked
        );
    }

    #[test]
    fn machine_stops_at_once_and_restarts_when_steady() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let b6 = Binding::Bound {
            name: "utun6".into(),
            index: 20,
        };
        let b7 = Binding::Bound {
            name: "utun7".into(),
            index: 21,
        };

        // Steady: nothing to do, ever.
        let mut m = Machine::new(b6.clone(), t0, None);
        for s in 0..20 {
            assert_eq!(m.tick(&b6, Some("utun6"), at(s * 3)), Action::None);
        }

        // VPN drops: stop on the first tick, no debounce.
        let mut m = Machine::new(b6.clone(), t0, None);
        assert_eq!(
            m.tick(&Binding::Blocked, Some("utun6"), at(40)),
            Action::Stop
        );
        assert!(m.stopped);
        // Restart once Blocked has held for two ticks.
        assert_eq!(m.tick(&Binding::Blocked, None, at(43)), Action::Restart);

        // Index reused by another interface: stop at once even if the route
        // still names utun6.
        let mut m = Machine::new(b6.clone(), t0, None);
        assert_eq!(m.tick(&b6, Some("en5"), at(40)), Action::Stop);

        // Reconnect to a new tunnel: stop, then restart when utun7 is steady.
        let mut m = Machine::new(b6.clone(), t0, None);
        assert_eq!(m.tick(&Binding::Blocked, None, at(40)), Action::Stop);
        assert_eq!(m.tick(&b7, None, at(43)), Action::None); // changed again
        assert_eq!(m.tick(&b7, None, at(46)), Action::Restart);

        // Flap guard: no restart in the first 30 s of a process.
        let mut m = Machine::new(Binding::Blocked, t0, None);
        assert_eq!(m.tick(&b6, None, at(3)), Action::None);
        assert_eq!(m.tick(&b6, None, at(6)), Action::None);
        assert_eq!(m.tick(&b6, None, at(31)), Action::Restart);

        // Blocked → VPN up: no stop needed (nothing leaks), debounced restart.
        let mut m = Machine::new(Binding::Blocked, t0, None);
        assert_eq!(m.tick(&b6, None, at(40)), Action::None);
        assert_eq!(m.tick(&b6, None, at(43)), Action::Restart);
        assert!(!m.stopped);
    }

    #[test]
    fn blocked_session_has_no_networking() {
        let base = SessionBase {
            session_dir: "s".into(),
            state_dir: "st".into(),
        };
        let s = Settings::resolve(
            &env_of(&[("STASH_LISTEN_PORT", "51413")]),
            &SettingsFile::default(),
        )
        .unwrap();
        let o = session_options(&base, &s, &Binding::Blocked, Some("file:///x".into()));
        assert!(o.dht.is_none());
        assert!(o.disable_trackers);
        assert!(o.disable_local_service_discovery);
        assert!(o.listen.is_none());
        assert!(o.blocklist_url.is_none());
        assert_eq!(o.bind_device_name.as_deref(), Some(loopback_name()));

        let o = session_options(
            &base,
            &s,
            &Binding::Bound {
                name: "utun6".into(),
                index: 1,
            },
            Some("file:///x".into()),
        );
        assert_eq!(o.bind_device_name.as_deref(), Some("utun6"));
        assert!(o.disable_local_service_discovery);
        assert!(!o.disable_trackers);
        let dht_file = o
            .dht
            .as_ref()
            .and_then(|d| d.persistence.as_ref())
            .and_then(|p| p.config_filename.clone());
        assert_eq!(dht_file, Some(PathBuf::from("st/dht-vpn.json")));
        let l = o.listen.as_ref().unwrap();
        assert_eq!(
            (l.announce_port, l.enable_upnp_port_forwarding),
            (Some(51413), false)
        );
        assert_eq!(o.blocklist_url.as_deref(), Some("file:///x"));

        let off = Settings::resolve(
            &env_of(&[
                ("STASH_VPN", "off"),
                ("STASH_UPNP", "on"),
                ("STASH_LISTEN_PORT", "51413"),
            ]),
            &SettingsFile::default(),
        )
        .unwrap();
        let o = session_options(&base, &off, &Binding::Unbound, None);
        assert!(o.bind_device_name.is_none());
        assert!(!o.disable_local_service_discovery);
        assert!(o.listen.unwrap().enable_upnp_port_forwarding);
    }

    #[test]
    fn range_counting_plain_and_gzip() {
        let text = b"# comment\nA:1.2.3.0-1.2.3.255\n\"B\" Ltd:5.6.7.8-5.6.7.9\njunk\n";
        assert_eq!(normalize_ranges(text).map(|r| r.1), Ok(2));
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(text).unwrap();
        assert_eq!(normalize_ranges(&gz.finish().unwrap()).map(|r| r.1), Ok(2));
        let long = format!("A:{}1.2.3.0-1.2.3.255\n", "x".repeat(5000));
        assert!(normalize_ranges(long.as_bytes()).is_err());
    }

    #[test]
    fn gzip_bomb_is_refused() {
        // 8 MB of 1 KB comment lines compresses to a few KB; with a 2 MB
        // cap it must be refused (the real cap is 512 MB; same code path).
        let mut line = vec![b'#'; 1023];
        line.push(b'\n');
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        for _ in 0..8192 {
            gz.write_all(&line).unwrap();
        }
        let bomb = gz.finish().unwrap();
        assert!(bomb.len() < 64 << 10);
        assert_eq!(
            normalize_ranges_capped(&bomb, 2 << 20).map(|r| r.1),
            Err("The blocklist is larger than 2 MB unpacked".into())
        );
    }

    #[test]
    fn urls_are_redacted_for_display() {
        assert_eq!(
            redact_url("https://user:secret@lists.example.com/p2p.gz?token=abc#x"),
            "https://lists.example.com/p2p.gz"
        );
        assert_eq!(redact_url(DEFAULT_BLOCKLIST), DEFAULT_BLOCKLIST);
        assert_eq!(
            BlocklistSource::Url("https://u:p@h/x?k=1".into())
                .label()
                .as_deref(),
            Some("https://h/x")
        );
    }

    #[tokio::test]
    async fn blocklist_file_url_is_absolute_from_relative_state_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = std::env::current_dir().unwrap();
        let rel = pathdiff(dir.path(), &cwd);
        let bl = Blocklist::new(&rel).unwrap();
        assert!(bl.file_url().is_none(), "no cache yet");
        let src = dir.path().join("in.p2p");
        std::fs::write(&src, "A:1.2.3.0-1.2.3.255\n").unwrap();
        bl.refresh(&BlocklistSource::File(src.clone()), true, None)
            .await;
        let url = bl.file_url().expect("cached");
        assert!(url.starts_with("file:///"), "{url}");
        let st = bl.status();
        assert_eq!(st.meta.ranges, Some(1));
        assert!(st.error.is_none());
        // A failed refresh keeps the cached copy.
        bl.refresh(
            &BlocklistSource::File(dir.path().join("missing")),
            true,
            None,
        )
        .await;
        assert!(bl.status().error.is_some());
        assert_eq!(bl.status().meta.ranges, Some(1));
        assert!(bl.file_url().is_some());
        // Not stale right after a refresh from the same source.
        assert!(!bl.stale(&src.display().to_string()));
    }

    /// Relative path from `base` to `path` (both absolute), for the test above.
    fn pathdiff(path: &Path, base: &Path) -> PathBuf {
        let (p, b): (Vec<_>, Vec<_>) = (path.components().collect(), base.components().collect());
        let common = p.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let mut out = PathBuf::new();
        for _ in common..b.len() {
            out.push("..");
        }
        for c in &p[common..] {
            out.push(c);
        }
        out
    }

    #[tokio::test]
    async fn writes_are_refused_while_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::resolve(&env_of(&[]), &SettingsFile::default()).unwrap();
        let p = Privacy::new(
            s,
            dir.path().join("settings.json"),
            Blocklist::new(dir.path()).unwrap(),
            Binding::Blocked,
            None,
        );
        assert!(p.write_guard().await.is_ok());
        p.accepting_writes.store(false, Ordering::Release);
        p.stopped.store(true, Ordering::Release);
        assert!(p.write_guard().await.is_err());
        let r = p.report();
        assert_eq!(r.state, KillState::Reconnecting);
        assert!(!r.accepting_writes);
        // A failed exec is its own state, not "no VPN".
        p.exec_failed.store(true, Ordering::Release);
        assert_eq!(p.report().state, KillState::RestartFailed);
        assert_eq!(
            serde_json::to_value(p.report().state).unwrap(),
            "restart_failed"
        );
    }

    #[test]
    fn same_failed_binding_never_restarts() {
        let t0 = Instant::now();
        let b6 = Binding::Bound {
            name: "utun6".into(),
            index: 20,
        };
        let b7 = Binding::Bound {
            name: "utun7".into(),
            index: 21,
        };
        // utun6 failed to start, so this process runs Blocked.
        let mut m = Machine::new(Binding::Blocked, t0, Some(b6.clone()));
        for s in 0..40 {
            assert_eq!(
                m.tick(&b6, None, t0 + Duration::from_secs(s * 3)),
                Action::None,
                "tick {s}"
            );
        }
        // A different tunnel is a reason to try again.
        assert_eq!(
            m.tick(&b7, None, t0 + Duration::from_secs(200)),
            Action::None
        );
        assert_eq!(
            m.tick(&b7, None, t0 + Duration::from_secs(203)),
            Action::Restart
        );
    }

    #[test]
    fn dht_identity_follows_the_binding() {
        let base = SessionBase {
            session_dir: "s".into(),
            state_dir: "st".into(),
        };
        let warn =
            Settings::resolve(&env_of(&[("STASH_VPN", "warn")]), &SettingsFile::default()).unwrap();
        let file = |b: &Binding| {
            session_options(&base, &warn, b, None)
                .dht
                .and_then(|d| d.persistence)
                .and_then(|p| p.config_filename)
        };
        assert_eq!(
            file(&Binding::Bound {
                name: "utun6".into(),
                index: 1
            }),
            Some(PathBuf::from("st/dht-vpn.json"))
        );
        assert_eq!(
            file(&Binding::Unbound),
            Some(PathBuf::from("st/dht-direct.json"))
        );
        assert_eq!(file(&Binding::Blocked), None);
    }

    #[test]
    fn non_utf8_lists_are_normalised_for_librqbit() {
        // Latin-1 organisation name: librqbit's own loader would reject it.
        let mut text = b"Caf\xe9 S.A.:1.2.3.0-1.2.3.255\n".to_vec();
        text.extend_from_slice(b"v6 net:2001:db8::-2001:db8::ffff\nbad:1.2.3.4-::1\n");
        let (out, n) = normalize_ranges(&text).unwrap();
        assert_eq!(n, 2);
        let out = String::from_utf8(out).expect("plain UTF-8");
        assert_eq!(out, "r:1.2.3.0-1.2.3.255\nr:2001:db8::-2001:db8::ffff\n");
    }

    #[tokio::test]
    async fn no_blocklist_download_while_stopped_or_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::resolve(&env_of(&[]), &SettingsFile::default()).unwrap();
        let mk = |b: Binding| {
            Privacy::new(
                s.clone(),
                dir.path().join("settings.json"),
                Blocklist::new(dir.path()).unwrap(),
                b,
                None,
            )
        };
        assert_eq!(mk(Binding::Blocked).download_route(), None);
        assert_eq!(mk(Binding::Unbound).download_route(), Some(None));
        let bound = mk(Binding::Bound {
            name: "utun6".into(),
            index: 1,
        });
        assert_eq!(bound.download_route(), Some(Some("utun6".into())));
        bound.stopped.store(true, Ordering::Release);
        assert_eq!(bound.download_route(), None);
        assert!(!mk(Binding::Blocked).can_add());
        assert!(bound.can_add());
    }

    #[tokio::test]
    async fn restart_is_pending_at_once_and_boot_ids_differ() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::resolve(&env_of(&[]), &SettingsFile::default()).unwrap();
        let p = Arc::new(Privacy::new(
            s.clone(),
            dir.path().join("settings.json"),
            Blocklist::new(dir.path()).unwrap(),
            Binding::Unbound,
            None,
        ));
        schedule_restart(&p);
        assert!(p.restart_pending.load(Ordering::Acquire));
        assert!(
            !p.restart_requested.load(Ordering::Acquire),
            "acted on later"
        );
        assert_eq!(p.report().restart_reason, Some(RestartReason::Settings));
        std::thread::sleep(Duration::from_millis(2));
        let q = Privacy::new(
            s,
            dir.path().join("x"),
            Blocklist::new(dir.path()).unwrap(),
            Binding::Unbound,
            None,
        );
        assert_ne!(p.boot_id(), q.boot_id());
    }
}
