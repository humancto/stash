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

    tracing::info!("stash listening on http://{addr}, saving to {}", dir.display());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn list(State(api): State<Arc<Api>>) -> impl IntoResponse {
    Json(api.api_torrent_list_ext(ApiTorrentListOpts { with_stats: true }))
}

#[derive(Deserialize)]
struct AddRequest {
    /// Magnet link, or an http(s) URL to a .torrent file.
    url: String,
}

async fn add(State(api): State<Arc<Api>>, Json(req): Json<AddRequest>) -> Result<impl IntoResponse> {
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

async fn pause(State(api): State<Arc<Api>>, Path(id): Path<TorrentIdOrHash>) -> Result<impl IntoResponse> {
    Ok(Json(api.api_torrent_action_pause(id).await?))
}

async fn start(State(api): State<Arc<Api>>, Path(id): Path<TorrentIdOrHash>) -> Result<impl IntoResponse> {
    Ok(Json(api.api_torrent_action_start(id).await?))
}

/// Removes the transfer and its files from disk.
async fn delete(State(api): State<Arc<Api>>, Path(id): Path<TorrentIdOrHash>) -> Result<impl IntoResponse> {
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

    // Parse "bytes=start-" or "bytes=start-end" (end inclusive).
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .and_then(|(s, e)| {
            let start = s.parse::<u64>().ok()?;
            let end = match e {
                "" => len,
                e => e.parse::<u64>().ok()?.saturating_add(1).min(len),
            };
            Some((start, end))
        });

    let (status, body_len, reader): (_, _, Box<dyn AsyncRead + Send + Unpin>) = match range {
        Some((start, end)) => {
            if start >= len || end <= start {
                out.insert(header::CONTENT_RANGE, num(format!("bytes */{len}")));
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, out).into_response());
            }
            file.seek(SeekFrom::Start(start))
                .await
                .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
            out.insert(
                header::CONTENT_RANGE,
                num(format!("bytes {start}-{}/{len}", end - 1)),
            );
            (StatusCode::PARTIAL_CONTENT, end - start, Box::new(file.take(end - start)))
        }
        None => (StatusCode::OK, len, Box::new(file)),
    };
    out.insert(header::CONTENT_LENGTH, num(body_len.to_string()));

    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(reader, 65536));
    Ok((status, out, body).into_response())
}

fn num(s: String) -> HeaderValue {
    HeaderValue::from_str(&s).expect("ascii header value")
}
