//! Serves the web UI: the Vite-built single-page app in `web/dist`.
//!
//! Release builds embed `web/dist` in the binary at compile time. Debug builds
//! read it from disk on each request (rust-embed behaviour), so a fresh
//! `npm --prefix web run build` shows up without recompiling. When
//! `index.html` is missing, a compiled-in placeholder page is served instead.
//!
//! Routing, for paths that no API route claims:
//! - `/api` and `/api/...`: 404 JSON in librqbit's `ApiError` shape (never the
//!   app shell, never compressed).
//! - other non-GET/HEAD: 405.
//! - an exact embedded file: that file. Vite hashes everything under
//!   `/assets/`, so those are cached forever; root files (favicon) revalidate.
//! - an `/assets/...` miss: 404, so a stale hashed URL can't get HTML back.
//! - anything else: `index.html`, so client-side routes deep-link.

use std::{borrow::Cow, fmt::Write as _};

use axum::{
    Json, Router,
    handler::Handler,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::any,
};
use rust_embed::RustEmbed;
use tower_http::{
    CompressionLevel,
    compression::{
        CompressionLayer,
        predicate::{DefaultPredicate, NotForContentType, Predicate},
    },
};

/// The built web UI. `allow_missing` lets `cargo build` and `cargo test`
/// work before the UI has been built.
#[derive(RustEmbed)]
#[folder = "web/dist"]
#[allow_missing = true]
pub struct Dist;

/// CSP for the app shell. Vite emits external scripts and styles only, so
/// nothing inline is allowed. `blob:`/`data:` cover generated downloads and
/// small images.
pub const INDEX_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; \
    font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; \
    connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; \
    frame-ancestors 'none'";

/// Served as `index.html` when the UI has not been built. No inline style or
/// script, so it works under [`INDEX_CSP`].
const PLACEHOLDER: &str = "<!doctype html>
<html lang=\"en\">
<head><meta charset=\"utf-8\"><title>stash</title></head>
<body>
<h1>UI not built &mdash; run <code>make web</code></h1>
<p>The API is up. Build the web UI with <code>make web</code>, then rebuild stash
(release builds embed <code>web/dist</code>; debug builds read it from disk).</p>
</body>
</html>
";

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Adds the UI routes to `router`: catch-all API 404s and a compressed
/// fallback for the app and its assets. Call before adding the guard layer
/// so the guard wraps these too.
pub fn attach<E, S>(router: Router<S>) -> Router<S>
where
    E: RustEmbed + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    // Brotli's default (11) is far too slow to run per request; 5 is close in
    // size and fast. The level also applies to gzip, where 5 is fine.
    // woff2 is already Brotli-compressed; compressing it again only costs CPU.
    let predicate = DefaultPredicate::new().and(NotForContentType::const_new("font/woff2"));
    let compression = CompressionLayer::new()
        .gzip(true)
        .br(true)
        .quality(CompressionLevel::Precise(5))
        .compress_when(predicate);
    router
        // Registered as routes, not handled in the fallback, so the
        // compression layer never sees an /api response.
        .route("/api", any(api_not_found))
        // A catch-all does not match an empty rest, so `/api/` is listed too.
        .route("/api/", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .fallback(spa::<E>.layer(compression))
}

/// Logs a warning if the UI is not built. Returns true if it is missing.
pub fn warn_if_unbuilt<E: RustEmbed>() -> bool {
    let missing = E::get("index.html").is_none();
    if missing {
        tracing::warn!(
            "web UI not built (web/dist/index.html missing); serving a placeholder page. Run `make web`"
        );
    }
    missing
}

async fn api_not_found() -> Response {
    let status = StatusCode::NOT_FOUND;
    let body = serde_json::json!({
        "error_kind": "not_found",
        "human_readable": "API endpoint not found",
        "status": status.as_u16(),
        "status_text": status.to_string(),
    });
    (status, Json(body)).into_response()
}

async fn spa<E: RustEmbed>(method: Method, uri: Uri, req: HeaderMap) -> Response {
    let path = uri.path();
    // Normally caught by the /api routes; kept so the fallback can never
    // answer an API path with HTML.
    if path == "/api" || path.starts_with("/api/") {
        return api_not_found().await;
    }
    if method != Method::GET && method != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, HeaderValue::from_static("GET, HEAD"))],
        )
            .into_response();
    }
    // Vite file names are plain ASCII, so the path is used as-is (no
    // percent-decoding).
    let rel = path.trim_start_matches('/');
    if rel.is_empty() || rel == "index.html" {
        return index::<E>(&req);
    }
    if let Some(file) = is_plain_path(rel).then(|| E::get(rel)).flatten() {
        let mut out = HeaderMap::new();
        let mime = HeaderValue::from_str(file.metadata.mimetype())
            .unwrap_or(HeaderValue::from_static("application/octet-stream"));
        out.insert(header::CONTENT_TYPE, mime);
        out.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(if rel.starts_with("assets/") {
                IMMUTABLE
            } else {
                "no-cache"
            }),
        );
        return respond(
            &req,
            out,
            Some(etag(file.metadata.sha256_hash())),
            file.data,
        );
    }
    if rel.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    index::<E>(&req)
}

/// The app shell, or the placeholder if the UI is not built.
fn index<E: RustEmbed>(req: &HeaderMap) -> Response {
    let mut out = HeaderMap::new();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    out.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(INDEX_CSP),
    );
    match E::get("index.html") {
        Some(f) => respond(req, out, Some(etag(f.metadata.sha256_hash())), f.data),
        None => respond(req, out, None, Cow::Borrowed(PLACEHOLDER.as_bytes())),
    }
}

/// 200 with `body`, or 304 if the request's `If-None-Match` matches. The 304
/// keeps every header of the 200 (browsers merge them into the cached copy),
/// so index.html keeps its CSP on revalidation.
fn respond(
    req: &HeaderMap,
    mut out: HeaderMap,
    tag: Option<HeaderValue>,
    body: Cow<'static, [u8]>,
) -> Response {
    if let Some(tag) = tag {
        let fresh = if_none_match(req, &tag);
        out.insert(header::ETAG, tag);
        if fresh {
            return (StatusCode::NOT_MODIFIED, out).into_response();
        }
    }
    (StatusCode::OK, out, body).into_response()
}

/// Weak ETag from the content hash. Weak because compression changes the
/// bytes on the wire but not the content.
fn etag(hash: [u8; 32]) -> HeaderValue {
    let mut s = String::with_capacity(2 + 2 + 64 + 1);
    s.push_str("W/\"");
    for b in hash {
        let _ = write!(s, "{b:02x}");
    }
    s.push('"');
    HeaderValue::from_str(&s).expect("hex is a valid header value")
}

/// True if any `If-None-Match` entry is `*` or weakly matches `tag`
/// (RFC 9110 §13.1.2: compare opaque tags, ignoring `W/`).
fn if_none_match(req: &HeaderMap, tag: &HeaderValue) -> bool {
    let Ok(tag) = tag.to_str() else { return false };
    fn opaque(t: &str) -> &str {
        t.strip_prefix("W/").unwrap_or(t)
    }
    let ours = opaque(tag);
    req.get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|t| t == "*" || opaque(t) == ours)
}

/// Rejects empty, `.` and `..` segments and backslashes, so a request can
/// never name a file outside the embedded folder (debug builds read disk).
fn is_plain_path(rel: &str) -> bool {
    !rel.contains('\\')
        && rel
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{Body, to_bytes},
        http::Request,
        middleware,
        routing::get,
    };
    use tower::ServiceExt;

    use super::*;
    use crate::security::{DEFAULT_CSP, GuardConfig, guard};

    #[derive(RustEmbed)]
    #[folder = "tests/fixtures/dist"]
    struct Fixture;

    #[derive(RustEmbed)]
    #[folder = "tests/fixtures/does-not-exist"]
    #[allow_missing = true]
    struct Unbuilt;

    /// Stands in for the real file-stream route: a 206 with a compressible
    /// body, like a range read of a torrent file.
    async fn stub_stream() -> Response {
        (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, "video/mp4"),
                (header::ACCEPT_RANGES, "bytes"),
                (header::CONTENT_RANGE, "bytes 0-4095/100000"),
            ],
            vec![b'a'; 4096],
        )
            .into_response()
    }

    /// Same shape as `main`: API routes, then `attach`, then the guard.
    fn app<E: RustEmbed + Send + Sync + 'static>() -> Router {
        let api = Router::new()
            .route(
                "/api/transfers",
                get(|| async { Json(serde_json::json!([])) }),
            )
            .route("/api/transfers/{id}/files/{file_id}", get(stub_stream));
        attach::<E, ()>(api).layer(middleware::from_fn_with_state(
            Arc::new(GuardConfig::default()),
            guard,
        ))
    }

    async fn send_to(app: Router, method: &str, uri: &str, extra: &[(&str, &str)]) -> Response {
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:3030");
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        app.oneshot(b.body(Body::empty()).unwrap()).await.unwrap()
    }

    async fn send(method: &str, uri: &str, extra: &[(&str, &str)]) -> Response {
        send_to(app::<Fixture>(), method, uri, extra).await
    }

    async fn body(resp: Response) -> String {
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn hdr<'a>(resp: &'a Response, name: &str) -> &'a str {
        resp.headers()
            .get(name)
            .unwrap_or_else(|| panic!("missing {name}"))
            .to_str()
            .unwrap()
    }

    #[tokio::test]
    async fn app_routes_serve_index() {
        for uri in ["/", "/watch/1/2", "/files", "/index.html", "/apiary"] {
            let resp = send("GET", uri, &[]).await;
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
            assert_eq!(hdr(&resp, "content-type"), "text/html; charset=utf-8");
            assert_eq!(hdr(&resp, "content-security-policy"), INDEX_CSP, "{uri}");
            assert_eq!(hdr(&resp, "cache-control"), "no-cache");
            assert!(hdr(&resp, "etag").starts_with("W/\""), "{uri}");
            assert_eq!(hdr(&resp, "x-content-type-options"), "nosniff");
            assert_eq!(hdr(&resp, "x-frame-options"), "DENY");
            assert!(body(resp).await.contains("fixture index page"), "{uri}");
        }
    }

    #[tokio::test]
    async fn etag_revalidates_with_304() {
        let tag = hdr(&send("GET", "/", &[]).await, "etag").to_owned();
        let strong = tag.trim_start_matches("W/").to_owned();
        let list = format!("\"nope\", {tag}");
        for inm in [tag.as_str(), strong.as_str(), list.as_str(), "*"] {
            let resp = send("GET", "/watch/3/4", &[("if-none-match", inm)]).await;
            assert_eq!(resp.status(), StatusCode::NOT_MODIFIED, "{inm}");
            // The 304 must keep the app's CSP, not get the guard's default.
            assert_eq!(hdr(&resp, "content-security-policy"), INDEX_CSP);
            assert_eq!(hdr(&resp, "cache-control"), "no-cache");
            assert_eq!(hdr(&resp, "etag"), tag);
            assert!(body(resp).await.is_empty());
        }
        let resp = send("GET", "/", &[("if-none-match", "W/\"other\"")]).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let js = "/assets/app-abc123.js";
        let tag = hdr(&send("GET", js, &[]).await, "etag").to_owned();
        assert_ne!(tag, hdr(&send("GET", "/", &[]).await, "etag"));
        let resp = send("GET", js, &[("if-none-match", &tag)]).await;
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(hdr(&resp, "cache-control"), IMMUTABLE);
    }

    #[tokio::test]
    async fn assets_and_root_files() {
        let resp = send("GET", "/assets/app-abc123.js", &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(hdr(&resp, "content-type").contains("javascript"));
        assert_eq!(hdr(&resp, "cache-control"), IMMUTABLE);
        assert_eq!(hdr(&resp, "content-security-policy"), DEFAULT_CSP);
        assert!(body(resp).await.contains("fixture app loaded"));

        let resp = send("GET", "/favicon.svg", &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(hdr(&resp, "content-type"), "image/svg+xml");
        assert_eq!(hdr(&resp, "cache-control"), "no-cache");
        assert_eq!(hdr(&resp, "content-security-policy"), DEFAULT_CSP);

        for uri in [
            "/assets/missing.js",
            "/assets/",
            "/assets/../index.html",
            "/assets/../../Cargo.toml",
        ] {
            let resp = send("GET", uri, &[]).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(hdr(&resp, "x-content-type-options"), "nosniff");
            assert_eq!(hdr(&resp, "content-security-policy"), DEFAULT_CSP);
        }
        // Traversal outside /assets/ falls through to the app shell.
        let resp = send("GET", "/../Cargo.toml", &[]).await;
        assert!(body(resp).await.contains("fixture index page"));
    }

    #[tokio::test]
    async fn unknown_api_paths_are_json_404() {
        for (method, uri) in [
            ("GET", "/api"),
            ("GET", "/api/"),
            ("GET", "/api/nope"),
            ("GET", "/api/transfers/1/files"),
            ("GET", "/api/transfers/1/files/2/extra"),
            ("POST", "/api/nope"),
            ("DELETE", "/api"),
        ] {
            let resp = send(method, uri, &[("accept-encoding", "br, gzip")]).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{method} {uri}");
            assert_eq!(hdr(&resp, "content-type"), "application/json");
            assert!(resp.headers().get("content-encoding").is_none(), "{uri}");
            assert_eq!(hdr(&resp, "content-security-policy"), DEFAULT_CSP);
            let v: serde_json::Value = serde_json::from_str(&body(resp).await).unwrap();
            assert_eq!(v["error_kind"], "not_found");
            assert_eq!(v["status"], 404);
            assert_eq!(v["status_text"], "404 Not Found");
            assert!(v["human_readable"].is_string());
        }
        // Real API routes still win over the catch-all.
        let resp = send("GET", "/api/transfers", &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body(resp).await, "[]");
    }

    #[tokio::test]
    async fn writes_to_app_paths_are_405() {
        for (method, uri) in [
            ("POST", "/watch/1"),
            ("PUT", "/"),
            ("DELETE", "/favicon.svg"),
        ] {
            let resp = send(method, uri, &[]).await;
            assert_eq!(
                resp.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {uri}"
            );
            assert_eq!(hdr(&resp, "allow"), "GET, HEAD");
        }
    }

    #[tokio::test]
    async fn head_has_headers_and_no_body() {
        for uri in ["/", "/assets/app-abc123.js"] {
            let resp = send("HEAD", uri, &[]).await;
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
            assert!(resp.headers().contains_key("etag"));
            assert!(resp.headers().contains_key("content-type"));
            assert!(body(resp).await.is_empty(), "{uri}");
        }
    }

    #[tokio::test]
    async fn fonts_are_not_recompressed() {
        let resp = send(
            "GET",
            "/assets/font-abc123.woff2",
            &[("accept-encoding", "br, gzip")],
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(hdr(&resp, "content-type"), "font/woff2");
        assert!(resp.headers().get("content-encoding").is_none());
    }

    #[tokio::test]
    async fn head_revalidates_with_304() {
        let tag = hdr(&send("GET", "/", &[]).await, "etag").to_owned();
        let resp = send("HEAD", "/", &[("if-none-match", &tag)]).await;
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn compression_only_on_app_routes() {
        // Positive controls: the app shell and assets do get compressed.
        let resp = send("GET", "/", &[("accept-encoding", "br")]).await;
        assert_eq!(hdr(&resp, "content-encoding"), "br");
        let resp = send(
            "GET",
            "/assets/app-abc123.js",
            &[("accept-encoding", "gzip")],
        )
        .await;
        assert_eq!(hdr(&resp, "content-encoding"), "gzip");

        // A range read from the file stream route must reach the client as is.
        let resp = send(
            "GET",
            "/api/transfers/1/files/0",
            &[("accept-encoding", "br, gzip"), ("range", "bytes=0-4095")],
        )
        .await;
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert!(resp.headers().get("content-encoding").is_none());
        assert_eq!(hdr(&resp, "content-range"), "bytes 0-4095/100000");
        assert_eq!(body(resp).await.len(), 4096);
    }

    #[tokio::test]
    async fn unbuilt_ui_serves_placeholder() {
        assert!(warn_if_unbuilt::<Unbuilt>());
        assert!(!warn_if_unbuilt::<Fixture>());
        for uri in ["/", "/files"] {
            let resp = send_to(app::<Unbuilt>(), "GET", uri, &[]).await;
            assert_eq!(resp.status(), StatusCode::OK);
            assert_eq!(hdr(&resp, "content-security-policy"), INDEX_CSP);
            assert_eq!(hdr(&resp, "cache-control"), "no-cache");
            assert!(body(resp).await.contains("run <code>make web</code>"));
        }
        let resp = send_to(app::<Unbuilt>(), "GET", "/assets/app.js", &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn if_none_match_parsing() {
        let tag = HeaderValue::from_static("W/\"abc\"");
        let check = |vals: &[&str]| {
            let mut h = HeaderMap::new();
            for v in vals {
                h.append(header::IF_NONE_MATCH, HeaderValue::from_str(v).unwrap());
            }
            if_none_match(&h, &tag)
        };
        assert!(check(&["W/\"abc\""]));
        assert!(check(&["\"abc\""]));
        assert!(check(&["\"x\",W/\"abc\""]));
        assert!(check(&["\"x\"", "\"abc\""]));
        assert!(check(&["*"]));
        assert!(!check(&[]));
        assert!(!check(&["\"abcd\""]));
        assert!(!check(&["abc"]));
    }

    #[test]
    fn plain_paths_only() {
        assert!(is_plain_path("assets/app.js"));
        assert!(is_plain_path("favicon.svg"));
        for bad in ["", "a//b", "../x", "assets/../x", "./x", "a\\b", "a/"] {
            assert!(!is_plain_path(bad), "{bad}");
        }
    }
}
