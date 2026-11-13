//! Request guards and response hardening.
//!
//! stash has no authentication yet, so the browser is the main attack surface:
//! - DNS rebinding: a hostile domain re-pointed at 127.0.0.1 would otherwise be
//!   able to read and drive the API. Only IP-literal hosts, `localhost` and
//!   explicitly configured names are accepted.
//! - CSRF: state-changing requests must be same-origin.
//! - Torrent content: only media and raster images are served inline, inside a
//!   CSP sandbox, so a `.html` or `.svg` in a torrent can't run script on the
//!   app origin.

use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
};

use axum::{
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// Extra host names (lowercase) accepted in `Host`, e.g. a Tailscale name.
#[derive(Debug, Default, Clone)]
pub struct GuardConfig {
    pub extra_hosts: Vec<String>,
}

impl GuardConfig {
    /// Parses a comma-separated `STASH_ALLOWED_HOSTS` value.
    pub fn from_list(list: &str) -> Self {
        Self {
            extra_hosts: list
                .split(',')
                .map(|h| h.trim().to_ascii_lowercase())
                // Host matching ignores ports, so drop any given here.
                .map(|h| match split_authority(&h) {
                    Some((name, _)) => name.to_owned(),
                    None => h,
                })
                .filter(|h| !h.is_empty())
                .collect(),
        }
    }
}

/// CSP for responses that set none: nothing may load, nothing may frame.
pub const DEFAULT_CSP: &str = "default-src 'none'; frame-ancestors 'none'";

/// Middleware: rejects unexpected hosts and cross-origin writes, and adds
/// baseline headers to every response.
pub async fn guard(State(cfg): State<Arc<GuardConfig>>, req: Request, next: Next) -> Response {
    // HTTP/2 carries the authority in the URI instead of a Host header. A Host
    // header that is present but not valid ASCII is rejected, not skipped.
    let host = match req.headers().get(header::HOST) {
        Some(v) => v.to_str().ok().map(str::to_owned),
        None => req.uri().authority().map(|a| a.as_str().to_owned()),
    };
    let Some(host) = host else {
        return reject("missing Host header");
    };
    if !host_allowed(&host, &cfg.extra_hosts) {
        return reject("host not allowed; add it to STASH_ALLOWED_HOSTS");
    }
    let same_origin = {
        let h = req.headers();
        let get = |name: &str| h.get(name).and_then(|v| v.to_str().ok());
        origin_ok(
            req.method(),
            get("origin"),
            get("sec-fetch-site"),
            &host,
            &cfg.extra_hosts,
        )
    };
    if !same_origin {
        return reject("cross-origin request refused");
    }

    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(HeaderValue::from_static("nosniff"));
    h.entry(header::X_FRAME_OPTIONS)
        .or_insert(HeaderValue::from_static("DENY"));
    // Locks down anything without its own policy (JSON, static assets).
    // index.html and file streams set their own.
    h.entry(header::CONTENT_SECURITY_POLICY)
        .or_insert(HeaderValue::from_static(DEFAULT_CSP));
    resp
}

fn reject(msg: &'static str) -> Response {
    (StatusCode::FORBIDDEN, msg).into_response()
}

/// Splits an authority (`host`, `host:port`, `[v6]`, `[v6]:port`) into its
/// host and optional port. Returns `None` if it is malformed.
fn split_authority(auth: &str) -> Option<(&str, Option<u16>)> {
    let (host, rest) = if let Some(inner) = auth.strip_prefix('[') {
        let end = inner.find(']')?;
        let host = &inner[..end];
        host.parse::<Ipv6Addr>().ok()?;
        (host, &inner[end + 1..])
    } else {
        match auth.find(':') {
            Some(i) => (&auth[..i], &auth[i..]),
            None => (auth, ""),
        }
    };
    if host.is_empty() {
        return None;
    }
    let port = match rest {
        "" => None,
        r => {
            let digits = r.strip_prefix(':')?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some(digits.parse().ok()?)
        }
    };
    Some((host, port))
}

/// True if `host` (a `Host` header value) is an IP literal, exactly
/// `localhost`, or one of `extra` (lowercase). DNS rebinding needs a DNS name,
/// so IP literals are safe to accept.
pub fn host_allowed(host: &str, extra: &[String]) -> bool {
    let Some((name, _port)) = split_authority(host) else {
        return false;
    };
    name.parse::<Ipv4Addr>().is_ok()
        || name.parse::<Ipv6Addr>().is_ok()
        || name.eq_ignore_ascii_case("localhost")
        || extra.iter().any(|e| name.eq_ignore_ascii_case(e))
}

/// True if a request may proceed as far as CSRF is concerned. Safe methods
/// always pass. Others need an `Origin` that matches `host` and is itself an
/// allowed host; without `Origin` (e.g. curl) they pass unless the browser's
/// `Sec-Fetch-Site` says the request came from another site.
pub fn origin_ok(
    method: &Method,
    origin: Option<&str>,
    sec_fetch_site: Option<&str>,
    host: &str,
    extra: &[String],
) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    let Some(origin) = origin else {
        return matches!(sec_fetch_site, None | Some("same-origin") | Some("none"));
    };
    let lower = origin.to_ascii_lowercase();
    let (auth, default_port) = if let Some(a) = lower.strip_prefix("http://") {
        (a, 80)
    } else if let Some(a) = lower.strip_prefix("https://") {
        (a, 443)
    } else {
        return false; // includes "null"
    };
    if auth.contains('/') || !host_allowed(auth, extra) {
        return false;
    }
    let (Some((o_name, o_port)), Some((h_name, h_port))) =
        (split_authority(auth), split_authority(host))
    else {
        return false;
    };
    let o_port = o_port.unwrap_or(default_port);
    let h_port = h_port.unwrap_or(default_port);
    o_name.eq_ignore_ascii_case(h_name) && o_port == h_port
}

/// Content types that browsers render without running script.
pub fn is_inline_safe(mime: Option<&str>) -> bool {
    let Some(mime) = mime else { return false };
    let mime = mime.to_ascii_lowercase();
    mime.starts_with("video/")
        || mime.starts_with("audio/")
        || matches!(
            mime.as_str(),
            "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif"
        )
}

/// `Content-Disposition` for `filename`, with an ASCII `filename=` fallback
/// and an RFC 8187 `filename*=` carrying the real UTF-8 name.
pub fn content_disposition(attachment: bool, filename: &str) -> String {
    let kind = if attachment { "attachment" } else { "inline" };
    let ascii: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && !matches!(c, '"' | '\\' | '%') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::with_capacity(filename.len());
    for b in filename.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// True if the raw query string asks for a download (`download` or
/// `download=1`). Never fails, so a bad query can't break playback.
pub fn wants_download(query: Option<&str>) -> bool {
    query.is_some_and(|q| {
        q.split('&')
            .any(|kv| kv == "download" || kv == "download=1" || kv == "download=true")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, middleware, routing::get};
    use tower::ServiceExt;

    fn extra() -> Vec<String> {
        vec!["stash.tail1234.ts.net".into()]
    }

    #[test]
    fn host_allowed_table() {
        let cases = [
            ("127.0.0.1:3030", true),
            ("127.0.0.1", true),
            ("[::1]:3030", true),
            ("[::1]", true),
            ("192.168.1.5:3030", true),
            ("localhost:3030", true),
            ("LOCALHOST:1", true),
            ("localhost", true),
            ("stash.tail1234.ts.net", true),
            ("STASH.tail1234.ts.net:443", true),
            ("evil.com", false),
            ("evil.com:3030", false),
            ("localhost.:3030", false),
            ("a.localhost:3030", false),
            ("127.0.0.1.evil.com", false),
            ("::1", false),
            ("[evil]:80", false),
            ("[::1]x", false),
            ("127.0.0.1:", false),
            ("127.0.0.1:99999", false),
            ("", false),
            ("a b", false),
        ];
        for (host, want) in cases {
            assert_eq!(host_allowed(host, &extra()), want, "{host}");
        }
    }

    #[test]
    fn origin_ok_table() {
        let h = "127.0.0.1:3030";
        let e = extra();
        let post = Method::POST;
        assert!(origin_ok(
            &Method::GET,
            Some("http://evil.com"),
            None,
            h,
            &e
        ));
        assert!(origin_ok(&post, Some("http://127.0.0.1:3030"), None, h, &e));
        assert!(origin_ok(&post, Some("HTTP://127.0.0.1:3030"), None, h, &e));
        assert!(!origin_ok(&post, Some("http://evil.com"), None, h, &e));
        assert!(!origin_ok(
            &post,
            Some("http://127.0.0.1:8080"),
            None,
            h,
            &e
        ));
        assert!(!origin_ok(
            &post,
            Some("http://localhost:3030"),
            None,
            h,
            &e
        ));
        assert!(!origin_ok(&post, Some("null"), None, h, &e));
        assert!(!origin_ok(
            &post,
            Some("http://127.0.0.1:3030/x"),
            None,
            h,
            &e
        ));
        assert!(origin_ok(&post, None, None, h, &e));
        assert!(origin_ok(&post, None, Some("same-origin"), h, &e));
        assert!(origin_ok(&post, None, Some("none"), h, &e));
        assert!(!origin_ok(&post, None, Some("cross-site"), h, &e));
        assert!(!origin_ok(&post, None, Some("same-site"), h, &e));
        // Default ports: Host without a port matches the Origin scheme's default.
        assert!(origin_ok(
            &post,
            Some("http://localhost"),
            None,
            "localhost:80",
            &e
        ));
        let ts = "stash.tail1234.ts.net";
        assert!(origin_ok(
            &post,
            Some("https://stash.tail1234.ts.net"),
            None,
            ts,
            &e
        ));
        assert!(!origin_ok(
            &Method::DELETE,
            Some("https://evil.ts.net"),
            None,
            ts,
            &e
        ));
        // https Origin defaults to 443, so it does not match Host on port 80.
        assert!(!origin_ok(
            &post,
            Some("https://localhost"),
            None,
            "localhost:80",
            &e
        ));
    }

    #[test]
    fn allowed_hosts_list_drops_ports() {
        let cfg = GuardConfig::from_list(" Foo.ts.net:443 , ,bar.lan");
        assert_eq!(cfg.extra_hosts, vec!["foo.ts.net", "bar.lan"]);
        assert!(host_allowed("foo.ts.net:3030", &cfg.extra_hosts));
    }

    #[test]
    fn inline_safe_table() {
        let cases = [
            (Some("video/mp4"), true),
            (Some("video/x-matroska"), true),
            (Some("audio/mpeg"), true),
            (Some("image/jpeg"), true),
            (Some("IMAGE/PNG"), true),
            (Some("image/svg+xml"), false),
            (Some("text/html"), false),
            (Some("application/xhtml+xml"), false),
            (Some("application/xml"), false),
            (Some("application/pdf"), false),
            (Some("text/plain"), false),
            (Some("application/javascript"), false),
            (Some("application/x-subrip"), false),
            (Some("application/octet-stream"), false),
            (None, false),
        ];
        for (mime, want) in cases {
            assert_eq!(is_inline_safe(mime), want, "{mime:?}");
        }
    }

    #[test]
    fn content_disposition_encodes() {
        assert_eq!(
            content_disposition(true, "100%.txt"),
            "attachment; filename=\"100_.txt\"; filename*=UTF-8''100%25.txt"
        );
        assert_eq!(
            content_disposition(true, "Big Buck Bunny.mp4"),
            "attachment; filename=\"Big Buck Bunny.mp4\"; filename*=UTF-8''Big%20Buck%20Bunny.mp4"
        );
        assert_eq!(
            content_disposition(true, "a\"b\\c\nd.txt"),
            "attachment; filename=\"a_b_c_d.txt\"; filename*=UTF-8''a%22b%5Cc%0Ad.txt"
        );
        assert_eq!(
            content_disposition(false, "é.mkv"),
            "inline; filename=\"_.mkv\"; filename*=UTF-8''%C3%A9.mkv"
        );
        // Every output must be a valid header value.
        for name in ["x\r\ny", "日本語.srt", "\u{0}"] {
            assert!(HeaderValue::from_str(&content_disposition(true, name)).is_ok());
        }
    }

    #[test]
    fn wants_download_table() {
        assert!(wants_download(Some("download=1")));
        assert!(wants_download(Some("a=b&download")));
        assert!(!wants_download(Some("download=0")));
        assert!(!wants_download(Some("%%%")));
        assert!(!wants_download(None));
    }

    async fn status(req: axum::http::Request<Body>) -> StatusCode {
        let app = Router::new()
            .route("/", get(|| async { "ok" }).post(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(
                Arc::new(GuardConfig::default()),
                guard,
            ));
        app.oneshot(req).await.unwrap().status()
    }

    fn req(method: &str, host: &str, origin: Option<&str>) -> axum::http::Request<Body> {
        let mut b = axum::http::Request::builder()
            .method(method)
            .uri("/")
            .header("host", host);
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        b.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn guard_rejects_rebinding_and_csrf() {
        assert_eq!(
            status(req("GET", "evil.com", None)).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(req("GET", "127.0.0.1:3030", None)).await,
            StatusCode::OK
        );
        let cross = req("POST", "127.0.0.1:3030", Some("http://evil.com"));
        assert_eq!(status(cross).await, StatusCode::FORBIDDEN);
        let same = req("POST", "127.0.0.1:3030", Some("http://127.0.0.1:3030"));
        assert_eq!(status(same).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn guard_adds_baseline_headers() {
        let app =
            Router::new()
                .route("/", get(|| async { "ok" }))
                .layer(middleware::from_fn_with_state(
                    Arc::new(GuardConfig::default()),
                    guard,
                ));
        let resp = app.oneshot(req("GET", "localhost", None)).await.unwrap();
        assert_eq!(resp.headers()["x-content-type-options"], "nosniff");
        assert_eq!(resp.headers()["x-frame-options"], "DENY");
        assert_eq!(resp.headers()["content-security-policy"], DEFAULT_CSP);
    }

    #[tokio::test]
    async fn guard_keeps_handler_csp() {
        let app = Router::new()
            .route(
                "/",
                get(|| async { ([(header::CONTENT_SECURITY_POLICY, "sandbox")], "ok") }),
            )
            .layer(middleware::from_fn_with_state(
                Arc::new(GuardConfig::default()),
                guard,
            ));
        let resp = app.oneshot(req("GET", "localhost", None)).await.unwrap();
        assert_eq!(resp.headers()["content-security-policy"], "sandbox");
        assert_eq!(resp.headers()["x-content-type-options"], "nosniff");
    }
}
