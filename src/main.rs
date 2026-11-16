//! stash: a personal put.io-style box.
//! One binary: torrent engine (librqbit) + HTTP API + web UI.

mod network;
mod privacy;
mod security;
mod seeding;
mod web;

use std::{
    io::SeekFrom,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::{FromRef, Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use librqbit::{
    AddTorrent, AddTorrentOptions, Api, ApiError, Session,
    api::{ApiTorrentListOpts, TorrentIdOrHash},
};
use privacy::{Binding, Privacy};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};

/// librqbit's ApiError already carries a status code and serializes to JSON.
enum AppError {
    Api(ApiError),
    /// The kill switch has stopped the session; writes wait for the restart.
    Unavailable,
    /// Strict kill switch with no VPN: adding can't find peers.
    NoVpn,
}

impl From<ApiError> for AppError {
    fn from(e: ApiError) -> Self {
        Self::Api(e)
    }
}

impl From<privacy::Unavailable> for AppError {
    fn from(_: privacy::Unavailable) -> Self {
        Self::Unavailable
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(e) => (e.status(), Json(&e)).into_response(),
            Self::Unavailable => privacy::Unavailable.into_response(),
            Self::NoVpn => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "human_readable": "No VPN is connected, so the kill switch has stopped all torrent traffic. Connect your VPN, then add this again."
                })),
            )
                .into_response(),
        }
    }
}

#[derive(Clone)]
struct AppState {
    api: Arc<Api>,
    probe: Arc<network::NetworkProbe>,
    privacy: Arc<Privacy>,
    seeding: Arc<seeding::Seeding>,
}

impl FromRef<AppState> for Arc<seeding::Seeding> {
    fn from_ref(s: &AppState) -> Self {
        s.seeding.clone()
    }
}

impl FromRef<AppState> for Arc<Api> {
    fn from_ref(s: &AppState) -> Self {
        s.api.clone()
    }
}
impl FromRef<AppState> for Arc<network::NetworkProbe> {
    fn from_ref(s: &AppState) -> Self {
        s.probe.clone()
    }
}
impl FromRef<AppState> for Arc<Privacy> {
    fn from_ref(s: &AppState) -> Self {
        s.privacy.clone()
    }
}

type Result<T> = std::result::Result<T, AppError>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::var("RUST_LOG").is_err() {
        unsafe { std::env::set_var("RUST_LOG", "info") };
    }
    tracing_subscriber::fmt::init();

    let dir = PathBuf::from(std::env::var("STASH_DIR").unwrap_or_else(|_| "downloads".into()));
    // Local-only by default: there is no auth. Set STASH_ADDR=0.0.0.0:3030 to expose on the LAN.
    let addr: SocketAddr = std::env::var("STASH_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3030".into())
        .parse()
        .context("STASH_ADDR must be host:port")?;
    let state_dir =
        PathBuf::from(std::env::var("STASH_STATE_DIR").unwrap_or_else(|_| "stash-state".into()));
    let session_dir = prepare_state_dir(&dir, &state_dir)?;
    let guard_cfg = Arc::new(security::GuardConfig::from_list(
        &std::env::var("STASH_ALLOWED_HOSTS").unwrap_or_default(),
    ));

    let env = |k: &str| std::env::var(k).ok();
    let settings_path = state_dir.join("settings.json");
    let settings = privacy::Settings::resolve(&env, &privacy::SettingsFile::load(&settings_path))?;
    let base = privacy::SessionBase {
        session_dir,
        state_dir: state_dir.canonicalize()?,
    };
    let blocklist = privacy::Blocklist::new(&state_dir)?;

    // Decide the binding before the first session, so traffic never starts
    // on the wrong interface.
    let mode = settings.vpn.clone();
    let mut binding = tokio::task::spawn_blocking(move || {
        privacy::desired_binding(&mode, privacy::route_now().as_ref(), &privacy::if_index)
    })
    .await?;
    if settings.upnp && settings.vpn.level != privacy::Level::Off {
        tracing::warn!(
            "STASH_UPNP is ignored while the kill switch is on (it would open a port on your router)"
        );
    }
    // Only a list fetched from the current source; never one left over from
    // another source.
    let mut list_url = (settings.blocklist != privacy::BlocklistSource::Off)
        .then(|| blocklist.file_url_for(&settings.blocklist))
        .flatten();
    let mut failed_binding = None;
    // Each attempt gets its own cancellation token: librqbit starts the
    // listener and DHT before it loads the blocklist, and does not stop them
    // if a later step fails. Cancel them before trying again.
    let open_session = |binding: &Binding, list: Option<String>| {
        let token = tokio_util::sync::CancellationToken::new();
        let mut opts = privacy::session_options(&base, &settings, binding, list);
        opts.cancellation_token = Some(token.clone());
        let attempt = Session::new_with_opts(dir.clone(), opts);
        async move {
            let r = attempt.await;
            if r.is_err() {
                token.cancel();
                // Give the half-started tasks a moment to release their sockets.
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            r
        }
    };
    let mut result = open_session(&binding, list_url.clone()).await;
    if let Err(e) = &result {
        if is_addr_in_use(e) && settings.listen_port.is_some() {
            anyhow::bail!(
                "STASH_LISTEN_PORT={} is already in use by another program; pick another port",
                settings.listen_port.unwrap_or_default()
            );
        }
        if list_url.is_some() {
            // A list librqbit rejects must not keep stash from starting.
            tracing::warn!(error = format!("{e:#}"), "starting without the blocklist");
            list_url = None;
            result = open_session(&binding, None).await;
        }
    }
    let session = match result {
        Ok(s) => s,
        Err(e) if matches!(binding, Binding::Bound { .. }) => {
            // The tunnel vanished since the probe, or (Linux < 5.7) binding
            // needs CAP_NET_RAW. Fail closed, and remember the binding so the
            // supervisor doesn't restart into the same failure forever.
            tracing::error!(
                error = format!("{e:#}"),
                "could not start the torrent session bound to the VPN (see error for the cause); torrents are stopped (STASH_VPN={:?})",
                settings.vpn.level
            );
            failed_binding = Some(binding.clone());
            binding = Binding::Blocked;
            open_session(&binding, None)
                .await
                .context("error creating torrent session")?
        }
        Err(e) => return Err(e.context("error creating torrent session")),
    };
    blocklist.mark_in_use(list_url.is_some() && !matches!(binding, Binding::Blocked));
    match &binding {
        Binding::Bound { name, .. } => {
            tracing::info!(interface = %name, "kill switch: torrent traffic uses {name} only")
        }
        Binding::Blocked => tracing::warn!(
            "STASH_VPN=strict: no VPN tunnel, torrents are stopped. Connect your VPN, or set STASH_VPN=warn or off"
        ),
        Binding::Unbound if settings.vpn.level == privacy::Level::Warn => {
            tracing::warn!("STASH_VPN=warn: no VPN tunnel, torrents use your normal connection")
        }
        Binding::Unbound => {}
    }

    let api = Arc::new(Api::new(session, None));
    let probe = Arc::new(network::NetworkProbe::new(network::ProbeConfig::public(
        network::lookup_enabled_from(std::env::var("STASH_IP_LOOKUP").ok().as_deref()),
    ))?);
    let privacy = Arc::new(Privacy::new(
        settings,
        settings_path,
        blocklist,
        binding.clone(),
        failed_binding,
    ));
    if let Some(via) = privacy.download_route() {
        let p = privacy.clone();
        tokio::spawn(async move {
            p.blocklist
                .refresh(&p.settings.blocklist, false, via.as_deref())
                .await
        });
    }
    // The supervisor is the kill switch: if it ever dies, stash must not keep
    // running without it.
    let supervisor = tokio::spawn(privacy::supervise(privacy.clone(), api.clone()));
    tokio::spawn(async move {
        let outcome = supervisor.await;
        tracing::error!(?outcome, "the kill switch supervisor stopped; exiting");
        std::process::exit(70);
    });

    let seeding = Arc::new(seeding::Seeding::new(
        privacy.settings.seeding,
        privacy.settings.seeding_from,
        &base.state_dir,
        privacy.boot_id(),
    ));
    let _ = privacy.seeding.set(seeding.clone());
    // The seeding rule is privacy-relevant too: if it dies, don't keep
    // running as if everything were "keep seeding forever".
    let enforcer = tokio::spawn(seeding::enforce(
        seeding.clone(),
        privacy.clone(),
        api.clone(),
    ));
    tokio::spawn(async move {
        let outcome = enforcer.await;
        tracing::error!(?outcome, "the seeding rule stopped; exiting");
        std::process::exit(70);
    });
    let state = AppState {
        api,
        probe,
        privacy,
        seeding,
    };

    web::warn_if_unbuilt::<web::Dist>();
    let api_routes = Router::new()
        .route("/api/transfers", get(list).post(add))
        .route("/api/transfers/{id}", get(details).delete(delete))
        .route("/api/transfers/{id}/pause", post(pause))
        .route("/api/transfers/{id}/start", post(start))
        .route("/api/transfers/{id}/files/{file_id}", get(stream))
        .route("/api/network", get(network::handler))
        .route(
            "/api/settings",
            get(privacy::get_settings).put(privacy::put_settings),
        )
        .route("/api/settings/restart", post(privacy::post_restart))
        .route(
            "/api/blocklist/refresh",
            post(privacy::post_blocklist_refresh),
        )
        .with_state(state);
    // The web UI is the fallback; the guard goes last so it wraps everything.
    let app = web::attach::<web::Dist, ()>(api_routes)
        .layer(middleware::from_fn_with_state(guard_cfg, security::guard));

    tracing::info!(
        "stash listening on http://{addr}, saving to {}",
        dir.display()
    );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn is_addr_in_use(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::AddrInUse)
            || c.to_string().contains("Address already in use")
    })
}

/// Creates the state dir, refuses layouts where torrent content could write
/// into it, and moves session state from the old `<download>/.session`
/// location. Returns the session persistence folder.
fn prepare_state_dir(download: &FsPath, state: &FsPath) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(download)
        .with_context(|| format!("creating {}", download.display()))?;
    std::fs::create_dir_all(state).with_context(|| format!("creating {}", state.display()))?;
    let d = download.canonicalize()?;
    let s = state.canonicalize()?;
    // Either direction of nesting lets torrent content write session files.
    if s.starts_with(&d) || d.starts_with(s.join("session")) {
        anyhow::bail!(
            "STASH_STATE_DIR ({}) must not be inside STASH_DIR ({}): torrent content could overwrite it",
            s.display(),
            d.display()
        );
    }
    let old = download.join(".session");
    let new = state.join("session");
    match (old.exists(), new.exists()) {
        (true, true) => anyhow::bail!(
            "found session state in both {} (old) and {} (new); keep one and remove the other",
            old.display(),
            new.display()
        ),
        (true, false) => {
            tracing::warn!(from = %old.display(), to = %new.display(), "moving session state out of the download dir");
            std::fs::rename(&old, &new).with_context(|| {
                format!(
                    "could not move {} to {}; move it by hand and restart",
                    old.display(),
                    new.display()
                )
            })?;
        }
        _ => {}
    }
    Ok(new)
}

#[derive(serde::Serialize)]
struct TransferItem {
    #[serde(flatten)]
    details: librqbit::api::TorrentDetailsResponse,
    seeding: seeding::TransferSeeding,
}

#[derive(serde::Serialize)]
struct TransferList {
    torrents: Vec<TransferItem>,
}

/// Lists transfers with stats, files and seeding state. librqbit's list
/// leaves `files` empty ("filled in /details"), so fill them in from the
/// details call.
async fn list(
    State(api): State<Arc<Api>>,
    State(seed): State<Arc<seeding::Seeding>>,
) -> impl IntoResponse {
    let mut resp = api.api_torrent_list_ext(ApiTorrentListOpts { with_stats: true });
    // Must run after the list call has returned: calling details from inside
    // librqbit's `with_torrents` would take its db read lock re-entrantly,
    // which can deadlock when a writer is waiting.
    for t in &mut resp.torrents {
        let Some(id) = t.id else { continue };
        match api.api_torrent_details(TorrentIdOrHash::Id(id)) {
            Ok(details) => t.files = details.files,
            // Only fails if the torrent was deleted between the two calls.
            Err(e) => tracing::debug!(id, error = %e, "no details for listed torrent"),
        }
    }
    let state = seed.state.lock().await;
    let torrents = resp
        .torrents
        .into_iter()
        .map(|details| {
            let total = details.stats.as_ref().map_or(0, |s| s.total_bytes);
            let seeding = seed.view(&state, &details.info_hash, total);
            TransferItem { details, seeding }
        })
        .collect();
    Json(TransferList { torrents })
}

#[derive(Deserialize)]
struct AddRequest {
    /// Magnet link, or an http(s) URL to a .torrent file.
    url: String,
}

async fn add(
    State(api): State<Arc<Api>>,
    State(privacy): State<Arc<Privacy>>,
    Json(req): Json<AddRequest>,
) -> Result<impl IntoResponse> {
    let _writing = privacy.write_guard().await?;
    if !privacy.can_add() {
        return Err(AppError::NoVpn);
    }
    let opts = AddTorrentOptions {
        overwrite: true,
        ..Default::default()
    };
    let added = api
        .api_add_torrent(AddTorrent::from_url(req.url), Some(opts))
        .await?;
    Ok(Json(added))
}

async fn details(
    State(api): State<Arc<Api>>,
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    Ok(Json(api.api_torrent_details(id)?))
}

async fn pause(
    State(api): State<Arc<Api>>,
    State(privacy): State<Arc<Privacy>>,
    State(seed): State<Arc<seeding::Seeding>>,
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    let _writing = privacy.write_guard().await?;
    seed.on_user_pause(&api.mgr_handle(id)?).await;
    Ok(Json(api.api_torrent_action_pause(id).await?))
}

async fn start(
    State(api): State<Arc<Api>>,
    State(privacy): State<Arc<Privacy>>,
    State(seed): State<Arc<seeding::Seeding>>,
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    let _writing = privacy.write_guard().await?;
    seed.on_user_start(&api.mgr_handle(id)?).await;
    Ok(Json(api.api_torrent_action_start(id).await?))
}

/// Removes the transfer and its files from disk.
async fn delete(
    State(api): State<Arc<Api>>,
    State(privacy): State<Arc<Privacy>>,
    State(seed): State<Arc<seeding::Seeding>>,
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    let _writing = privacy.write_guard().await?;
    // Resolve the hash first: after the delete there is nothing to look up.
    let hash = api.mgr_handle(id)?.shared().info_hash.as_string();
    let resp = api.api_torrent_action_delete(id).await?;
    seed.on_deleted(&hash).await;
    Ok(Json(resp))
}

/// Serves a file with HTTP range support. The stream reads straight from the
/// torrent: if the requested bytes are not downloaded yet, librqbit bumps the
/// priority of those pieces and the read waits for them. That is what makes
/// "play while downloading" and seeking work.
async fn stream(
    State(api): State<Arc<Api>>,
    Path((id, file_id)): Path<(TorrentIdOrHash, usize)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Result<Response> {
    let mut file = api.api_stream(id, file_id).await?;
    let len = file.len();

    let mut out = HeaderMap::new();
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    // Torrent content is untrusted. Only media and raster images render
    // inline; anything else (html, svg, xml, pdf, ...) is a download. The CSP
    // sandbox stops script even if a browser renders something anyway.
    let mime = api.torrent_file_mime_type(id, file_id).ok();
    let inline = security::is_inline_safe(mime) && !security::wants_download(query.as_deref());
    match mime {
        Some(m) if inline => out.insert(header::CONTENT_TYPE, HeaderValue::from_static(m)),
        _ => out.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        ),
    };
    if !inline {
        let name = api
            .api_torrent_details(id)
            .ok()
            .and_then(|d| d.files)
            .and_then(|f| f.into_iter().nth(file_id))
            .and_then(|f| f.components.last().cloned())
            .unwrap_or_else(|| "download".into());
        let cd = HeaderValue::from_str(&security::content_disposition(true, &name))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
        out.insert(header::CONTENT_DISPOSITION, cd);
    }
    // `sandbox` gives the document an opaque origin, which stops Chromium's
    // media viewer from loading the file when it is opened in a tab. Inline
    // types are media and raster images only (no script, nosniff), so they
    // skip it; everything served as a download keeps it.
    out.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(if inline {
            "frame-ancestors 'none'"
        } else {
            "sandbox; frame-ancestors 'none'"
        }),
    );
    out.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    out.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );

    let range = parse_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        len,
    );

    let (status, body_len, reader): (_, _, Box<dyn AsyncRead + Send + Unpin>) = match range {
        RangeReq::Unsatisfiable => {
            out.insert(header::CONTENT_RANGE, num(format!("bytes */{len}")));
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, out).into_response());
        }
        RangeReq::Partial { start, end } => {
            file.seek(SeekFrom::Start(start))
                .await
                .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
            out.insert(header::CONTENT_RANGE, num(content_range(start, end, len)));
            (
                StatusCode::PARTIAL_CONTENT,
                end - start,
                Box::new(file.take(end - start)),
            )
        }
        RangeReq::Full => (StatusCode::OK, len, Box::new(file)),
    };
    out.insert(header::CONTENT_LENGTH, num(body_len.to_string()));

    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(reader, 65536));
    Ok((status, out, body).into_response())
}

fn num(s: String) -> HeaderValue {
    HeaderValue::from_str(&s).expect("ascii header value")
}

/// What to serve for a request's `Range` header (RFC 9110 §14.1.2).
#[derive(Debug, PartialEq, Eq)]
enum RangeReq {
    /// No usable range: serve the whole file with 200. Servers may ignore
    /// malformed, multi-part or non-byte ranges.
    Full,
    /// Serve bytes `[start, end)`; `end` is exclusive.
    Partial { start: u64, end: u64 },
    /// Well-formed but outside the file: 416.
    Unsatisfiable,
}

/// Parses a single byte range. Syntax is checked first; only a well-formed
/// range is then tested against `len`.
fn parse_range(header: Option<&str>, len: u64) -> RangeReq {
    enum Spec {
        From(u64, Option<u64>),
        Suffix(u64),
    }

    /// RFC 9110 allows only DIGITs. A digit string too large for u64 is still
    /// valid syntax, so it saturates instead of failing.
    fn digits(s: &str) -> Option<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(s.parse().unwrap_or(u64::MAX))
    }

    let spec = (|| {
        let (unit, set) = header?.split_once('=')?;
        if !unit.eq_ignore_ascii_case("bytes") || set.contains(',') {
            return None;
        }
        let (first, last) = set.split_once('-')?;
        if first.is_empty() {
            return Some(Spec::Suffix(digits(last)?));
        }
        let first = digits(first)?;
        let last = if last.is_empty() {
            None
        } else {
            Some(digits(last)?)
        };
        if last.is_some_and(|l| l < first) {
            return None;
        }
        Some(Spec::From(first, last))
    })();

    match spec {
        None => RangeReq::Full,
        Some(Spec::From(first, _)) if first >= len => RangeReq::Unsatisfiable,
        Some(Spec::From(first, last)) => RangeReq::Partial {
            start: first,
            end: last.map_or(len, |l| l.saturating_add(1).min(len)),
        },
        Some(Spec::Suffix(n)) if n == 0 || len == 0 => RangeReq::Unsatisfiable,
        Some(Spec::Suffix(n)) => RangeReq::Partial {
            start: len - n.min(len),
            end: len,
        },
    }
}

/// `Content-Range` value for bytes `[start, end)` of a `len`-byte file.
fn content_range(start: u64, end: u64, len: u64) -> String {
    format!("bytes {start}-{}/{len}", end - 1)
}

#[cfg(test)]
mod tests {
    use super::{RangeReq::*, content_range, parse_range};

    const LEN: u64 = 1000;

    fn p(start: u64, end: u64) -> super::RangeReq {
        Partial { start, end }
    }

    #[test]
    fn parse_range_table() {
        let cases: &[(Option<&str>, u64, super::RangeReq)] = &[
            (None, LEN, Full),
            (Some("bytes=0-"), LEN, p(0, LEN)),
            (Some("bytes=100-"), LEN, p(100, LEN)),
            (Some("bytes=100-199"), LEN, p(100, 200)),
            (Some("bytes=0-0"), LEN, p(0, 1)),
            (Some("bytes=0-999"), LEN, p(0, LEN)),
            (Some("bytes=500-5000"), LEN, p(500, LEN)),
            (Some("bytes=0-18446744073709551615"), LEN, p(0, LEN)),
            (Some("bytes=0-99999999999999999999999"), LEN, p(0, LEN)),
            (Some("bytes=99999999999999999999999-"), LEN, Unsatisfiable),
            (Some("bytes=-500"), LEN, p(500, LEN)),
            (Some("bytes=-1000"), LEN, p(0, LEN)),
            (Some("bytes=-5000"), LEN, p(0, LEN)),
            (Some("bytes=-99999999999999999999999"), LEN, p(0, LEN)),
            (Some("bytes=-0"), LEN, Unsatisfiable),
            (Some("bytes=1000-"), LEN, Unsatisfiable),
            (Some("bytes=2000-3000"), LEN, Unsatisfiable),
            (Some("Bytes=0-9"), LEN, p(0, 10)),
            (Some("BYTES=0-9"), LEN, p(0, 10)),
            (Some("bytes=-"), LEN, Full),
            (Some("bytes=5"), LEN, Full),
            (Some("bytes=+5-"), LEN, Full),
            (Some("bytes=-+5"), LEN, Full),
            (Some("bytes=0-+9"), LEN, Full),
            (Some("bytes= 0-1"), LEN, Full),
            (Some("bytes=0-1 "), LEN, Full),
            (Some("bytes=0-1,5-6"), LEN, Full),
            (Some("bytes=10-5"), LEN, Full),
            (Some("items=0-1"), LEN, Full),
            (Some("garbage"), LEN, Full),
            (Some(""), LEN, Full),
            (Some("bytes=0-1-2"), LEN, Full),
            (Some("garbage"), 0, Full),
            (Some("bytes=0-"), 0, Unsatisfiable),
            (Some("bytes=-5"), 0, Unsatisfiable),
        ];
        for (header, len, want) in cases {
            assert_eq!(&parse_range(*header, *len), want, "{header:?} len={len}");
        }
    }

    #[test]
    fn state_dir_migrates_old_session() {
        let root = tempfile::tempdir().unwrap();
        let (dl, st) = (
            root.path().join("downloads"),
            root.path().join("stash-state"),
        );
        std::fs::create_dir_all(dl.join(".session")).unwrap();
        std::fs::write(dl.join(".session/session.json"), "{}").unwrap();
        let got = super::prepare_state_dir(&dl, &st).unwrap();
        assert_eq!(got, st.join("session"));
        assert!(st.join("session/session.json").exists());
        assert!(!dl.join(".session").exists());
        // Second start is a no-op.
        assert_eq!(
            super::prepare_state_dir(&dl, &st).unwrap(),
            st.join("session")
        );
    }

    #[test]
    fn state_dir_refuses_both_and_nested() {
        let root = tempfile::tempdir().unwrap();
        let (dl, st) = (
            root.path().join("downloads"),
            root.path().join("stash-state"),
        );
        std::fs::create_dir_all(dl.join(".session")).unwrap();
        std::fs::create_dir_all(st.join("session")).unwrap();
        assert!(super::prepare_state_dir(&dl, &st).is_err());
        assert!(dl.join(".session").exists(), "must not touch either copy");
        assert!(super::prepare_state_dir(&dl, &dl.join("state")).is_err());
        assert!(super::prepare_state_dir(&dl, &dl).is_err());
        // Download dir equal to (or inside) the session folder.
        let st2 = root.path().join("st2");
        assert!(super::prepare_state_dir(&st2.join("session"), &st2).is_err());
    }

    #[test]
    fn content_range_is_inclusive() {
        assert_eq!(content_range(0, 1, 1000), "bytes 0-0/1000");
        assert_eq!(content_range(500, 1000, 1000), "bytes 500-999/1000");
        assert_eq!(
            content_range(276134447, 276134947, 276134947),
            "bytes 276134447-276134946/276134947"
        );
    }
}
