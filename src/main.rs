//! stash: a personal put.io-style box.
//! One binary: torrent engine (librqbit) + HTTP API + web UI.

use std::{io::SeekFrom, net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use librqbit::{
    AddTorrent, AddTorrentOptions, Api, ApiError, Session, SessionOptions,
    SessionPersistenceConfig,
    api::{ApiTorrentListOpts, TorrentIdOrHash},
};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};

/// librqbit's ApiError already carries a status code and serializes to JSON.
struct AppError(ApiError);

impl From<ApiError> for AppError {
    fn from(e: ApiError) -> Self {
        Self(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0.status(), Json(&self.0)).into_response()
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
    tokio::fs::create_dir_all(&dir).await?;

    let session = Session::new_with_opts(
        dir.clone(),
        SessionOptions {
            // Remember transfers across restarts, and skip re-hashing on resume.
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(dir.join(".session")),
            }),
            fastresume: true,
            ..Default::default()
        },
    )
    .await
    .context("error creating torrent session")?;

    let api = Arc::new(Api::new(session, None));

    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("index.html")) }))
        .route("/api/transfers", get(list).post(add))
        .route("/api/transfers/{id}", get(details).delete(delete))
        .route("/api/transfers/{id}/pause", post(pause))
        .route("/api/transfers/{id}/start", post(start))
        .route("/api/transfers/{id}/files/{file_id}", get(stream))
        .with_state(api);

    tracing::info!(
        "stash listening on http://{addr}, saving to {}",
        dir.display()
    );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// Lists transfers with stats and files. librqbit's list leaves `files` empty
/// ("filled in /details"), so fill them in from the details call.
async fn list(State(api): State<Arc<Api>>) -> impl IntoResponse {
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
    Json(resp)
}

#[derive(Deserialize)]
struct AddRequest {
    /// Magnet link, or an http(s) URL to a .torrent file.
    url: String,
}

async fn add(
    State(api): State<Arc<Api>>,
    Json(req): Json<AddRequest>,
) -> Result<impl IntoResponse> {
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
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    Ok(Json(api.api_torrent_action_pause(id).await?))
}

async fn start(
    State(api): State<Arc<Api>>,
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    Ok(Json(api.api_torrent_action_start(id).await?))
}

/// Removes the transfer and its files from disk.
async fn delete(
    State(api): State<Arc<Api>>,
    Path(id): Path<TorrentIdOrHash>,
) -> Result<impl IntoResponse> {
    Ok(Json(api.api_torrent_action_delete(id).await?))
}

/// Serves a file with HTTP range support. The stream reads straight from the
/// torrent: if the requested bytes are not downloaded yet, librqbit bumps the
/// priority of those pieces and the read waits for them. That is what makes
/// "play while downloading" and seeking work.
async fn stream(
    State(api): State<Arc<Api>>,
    Path((id, file_id)): Path<(TorrentIdOrHash, usize)>,
    headers: HeaderMap,
) -> Result<Response> {
    let mut file = api.api_stream(id, file_id).await?;
    let len = file.len();

    let mut out = HeaderMap::new();
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(mime) = api.torrent_file_mime_type(id, file_id) {
        out.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    }

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
    fn content_range_is_inclusive() {
        assert_eq!(content_range(0, 1, 1000), "bytes 0-0/1000");
        assert_eq!(content_range(500, 1000, 1000), "bytes 500-999/1000");
        assert_eq!(
            content_range(276134447, 276134947, 276134947),
            "bytes 276134447-276134946/276134947"
        );
    }
}
