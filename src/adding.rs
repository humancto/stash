//! What `POST /api/transfers` accepts: a magnet link, a bare info hash, an
//! http(s) URL of a `.torrent` file (JSON body), or the `.torrent` file
//! itself (raw body). Pure parsing plus a capped download; the handler in
//! `main.rs` does the guard checks and the add.

use std::time::Duration;

use axum::{body::Bytes, http::StatusCode};
use serde::Deserialize;

/// Largest `.torrent` stash accepts, uploaded or downloaded. The web UI
/// checks the same number before it sends.
pub const TORRENT_MAX_BYTES: usize = 16 << 20;
/// Largest JSON body (one URL).
pub const URL_MAX_BYTES: usize = 8 << 10;

#[derive(Debug, PartialEq)]
pub enum AddSource {
    /// A magnet link (normalised: lowercase scheme, trimmed).
    Magnet(String),
    /// An http(s) URL to download a `.torrent` from.
    Download(String),
    /// The bytes of a `.torrent` file.
    File(Bytes),
}

#[derive(Debug, PartialEq)]
pub enum AddError {
    /// Content type missing or not one we accept.
    UnsupportedType,
    TooLarge,
    Empty,
    BadJson,
    /// Not a magnet, info hash or http(s) URL.
    BadLink,
    NotATorrent,
    /// Downloading the `.torrent` failed; the text is safe to show.
    Download(String),
}

impl AddError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::UnsupportedType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Download(_) => StatusCode::BAD_GATEWAY,
            _ => StatusCode::BAD_REQUEST,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::UnsupportedType => {
                "Send a magnet link as JSON or a .torrent file as application/x-bittorrent.".into()
            }
            Self::TooLarge => "That .torrent file is larger than 16 MB.".into(),
            Self::Empty => "Paste a magnet link or a .torrent URL first.".into(),
            Self::BadJson => "The request wasn't valid JSON with a \"url\" field.".into(),
            Self::BadLink => "That isn't a magnet link or a .torrent URL.".into(),
            Self::NotATorrent => "That file isn't a valid .torrent.".into(),
            Self::Download(why) => format!("Could not download that .torrent ({why})."),
        }
    }
}

/// The media type of a `Content-Type` value: parameters dropped, trimmed,
/// lowercase.
fn media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

#[derive(Deserialize)]
struct UrlBody {
    url: String,
}

/// Decide what was sent. Only `application/json` and
/// `application/x-bittorrent` are accepted: never a CORS-safelisted type
/// (text/plain, form, multipart), so other sites can't send this without a
/// preflight the guard refuses.
pub fn parse_add(content_type: Option<&str>, body: &[u8]) -> Result<AddSource, AddError> {
    match content_type.map(media_type).as_deref() {
        Some("application/json") => {
            if body.len() > URL_MAX_BYTES {
                return Err(AddError::TooLarge);
            }
            let req: UrlBody = serde_json::from_slice(body).map_err(|_| AddError::BadJson)?;
            parse_link(&req.url)
        }
        Some("application/x-bittorrent") => torrent_bytes(Bytes::copy_from_slice(body)),
        _ => Err(AddError::UnsupportedType),
    }
}

/// Check that bytes look like a `.torrent` (a bencoded dictionary). librqbit
/// does the real decoding.
pub fn torrent_bytes(body: Bytes) -> Result<AddSource, AddError> {
    if body.is_empty() {
        return Err(AddError::Empty);
    }
    if body.len() > TORRENT_MAX_BYTES {
        return Err(AddError::TooLarge);
    }
    if body[0] != b'd' {
        return Err(AddError::NotATorrent);
    }
    Ok(AddSource::File(body))
}

fn is_hash(s: &str) -> bool {
    (s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        || (s.len() == 32
            && s.bytes()
                .all(|b| matches!(b.to_ascii_uppercase(), b'A'..=b'Z' | b'2'..=b'7')))
}

/// Strip `scheme` (ASCII case-insensitive) from the start of `s`.
fn strip_scheme<'a>(s: &'a str, scheme: &str) -> Option<&'a str> {
    let head = s.get(..scheme.len())?;
    head.eq_ignore_ascii_case(scheme)
        .then(|| &s[scheme.len()..])
}

/// A pasted link: magnet, bare info hash, or http(s) URL.
pub fn parse_link(raw: &str) -> Result<AddSource, AddError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(AddError::Empty);
    }
    if s.len() > URL_MAX_BYTES {
        return Err(AddError::TooLarge);
    }
    if s.chars().any(char::is_whitespace) {
        return Err(AddError::BadLink);
    }
    if let Some(rest) = strip_scheme(s, "magnet:") {
        // librqbit matches the scheme case-sensitively.
        if !rest.starts_with('?') {
            return Err(AddError::BadLink);
        }
        return Ok(AddSource::Magnet(format!("magnet:{rest}")));
    }
    if is_hash(s) {
        return Ok(AddSource::Magnet(format!("magnet:?xt=urn:btih:{s}")));
    }
    for scheme in ["http://", "https://"] {
        if let Some(rest) = strip_scheme(s, scheme) {
            let url = format!("{scheme}{rest}");
            return match reqwest::Url::parse(&url) {
                Ok(u) if u.host_str().is_some_and(|h| !h.is_empty()) => {
                    Ok(AddSource::Download(url))
                }
                _ => Err(AddError::BadLink),
            };
        }
    }
    Err(AddError::BadLink)
}

/// Is this URL's host this machine? Loopback traffic never leaves it, so it
/// needs no tunnel (and can't go through one).
fn is_loopback(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = u.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Download a `.torrent`: 30 s, at most 5 redirects, at most 16 MB. When
/// torrent traffic is bound to the VPN (`via`), so is this download, except
/// for loopback hosts (local indexers such as Jackett). The caller refuses
/// it when the kill switch blocks. The Origin guard keeps other web pages
/// from driving this. Errors never include the URL (it may carry a passkey).
pub async fn download(url: &str, via: Option<&str>) -> Result<Bytes, AddError> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5));
    if let Some(iface) = via.filter(|_| !is_loopback(url)) {
        builder = builder.interface(iface);
    }
    let client = builder
        .build()
        .map_err(|_| AddError::Download("could not set up the download".into()))?;
    let describe = |e: reqwest::Error| {
        AddError::Download(if e.is_timeout() {
            "timed out".into()
        } else if e.is_connect() {
            "could not reach the server".into()
        } else if e.is_redirect() {
            "too many redirects".into()
        } else {
            "the download failed".into()
        })
    };
    let mut resp = client.get(url).send().await.map_err(describe)?;
    if !resp.status().is_success() {
        return Err(AddError::Download(format!(
            "HTTP {}",
            resp.status().as_u16()
        )));
    }
    if resp
        .content_length()
        .is_some_and(|n| n > TORRENT_MAX_BYTES as u64)
    {
        return Err(AddError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(describe)? {
        if body.len() + chunk.len() > TORRENT_MAX_BYTES {
            return Err(AddError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "c9e15763f722f23e98a29decdfae341b98d53056";

    fn json(url: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "url": url })).unwrap()
    }

    #[test]
    fn links() {
        let m = |s: &str| AddSource::Magnet(s.into());
        let cases: &[(&str, Result<AddSource, AddError>)] = &[
            ("magnet:?xt=urn:btih:abc", Ok(m("magnet:?xt=urn:btih:abc"))),
            (
                "  MAGNET:?xt=urn:btih:abc\n",
                Ok(m("magnet:?xt=urn:btih:abc")),
            ),
            ("magnet:xt=urn", Err(AddError::BadLink)),
            (HASH, Ok(m(&format!("magnet:?xt=urn:btih:{HASH}")))),
            (
                "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
                Ok(m("magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")),
            ),
            (
                "HTTPS://example.com/a.torrent",
                Ok(AddSource::Download("https://example.com/a.torrent".into())),
            ),
            (
                "http://127.0.0.1:9117/dl/x?passkey=1",
                Ok(AddSource::Download(
                    "http://127.0.0.1:9117/dl/x?passkey=1".into(),
                )),
            ),
            ("http://", Err(AddError::BadLink)),
            ("/etc/passwd", Err(AddError::BadLink)),
            ("file:///etc/passwd", Err(AddError::BadLink)),
            ("ftp://x/a.torrent", Err(AddError::BadLink)),
            ("magnet:?xt=a b", Err(AddError::BadLink)),
            ("   ", Err(AddError::Empty)),
        ];
        for (input, want) in cases {
            assert_eq!(&parse_link(input), want, "{input:?}");
        }
        assert_eq!(
            parse_link(&"a".repeat(URL_MAX_BYTES + 1)),
            Err(AddError::TooLarge)
        );
    }

    #[test]
    fn content_types() {
        let body = json("magnet:?xt=urn:btih:abc");
        let ok = Ok(AddSource::Magnet("magnet:?xt=urn:btih:abc".into()));
        assert_eq!(parse_add(Some("application/json"), &body), ok);
        assert_eq!(
            parse_add(Some("Application/JSON; charset=utf-8"), &body),
            ok
        );
        assert_eq!(parse_add(None, &body), Err(AddError::UnsupportedType));
        for t in [
            "text/plain",
            "application/x-www-form-urlencoded",
            "multipart/form-data",
        ] {
            assert_eq!(
                parse_add(Some(t), &body),
                Err(AddError::UnsupportedType),
                "{t}"
            );
        }
        assert_eq!(
            parse_add(Some("application/json"), b"{"),
            Err(AddError::BadJson)
        );
        assert_eq!(
            parse_add(Some("application/json"), b"{}"),
            Err(AddError::BadJson)
        );
        let long = json(&"a".repeat(URL_MAX_BYTES));
        assert_eq!(
            parse_add(Some("application/json"), &long),
            Err(AddError::TooLarge)
        );
    }

    #[test]
    fn torrent_files() {
        let t = Some("application/x-bittorrent");
        assert_eq!(
            parse_add(t, b"d4:infod4:name1:aee"),
            Ok(AddSource::File(Bytes::from_static(b"d4:infod4:name1:aee")))
        );
        assert_eq!(parse_add(t, b""), Err(AddError::Empty));
        assert_eq!(parse_add(t, b"<html>"), Err(AddError::NotATorrent));
        let big = vec![b'd'; TORRENT_MAX_BYTES + 1];
        assert_eq!(parse_add(t, &big), Err(AddError::TooLarge));
    }

    #[test]
    fn loopback_hosts() {
        assert!(is_loopback("http://127.0.0.1:9117/x.torrent"));
        assert!(is_loopback("http://LOCALHOST/x.torrent"));
        assert!(is_loopback("http://[::1]/x.torrent"));
        assert!(!is_loopback("https://example.com/x.torrent"));
        assert!(!is_loopback("http://192.168.1.2/x.torrent"));
    }

    #[test]
    fn statuses() {
        assert_eq!(
            AddError::UnsupportedType.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(AddError::TooLarge.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(AddError::BadLink.status(), StatusCode::BAD_REQUEST);
        assert!(
            AddError::Download("HTTP 404".into())
                .message()
                .contains("HTTP 404")
        );
    }

    /// librqbit keeps one transfer per info hash: adding the same .torrent
    /// again is Ok with the existing id (the handler relies on this).
    #[tokio::test]
    async fn duplicate_add_returns_the_existing_id() {
        use librqbit::{AddTorrent, AddTorrentOptions, Api, Session, SessionOptions};
        let dir = tempfile::tempdir().unwrap();
        let session = Session::new_with_opts(
            dir.path().to_path_buf(),
            SessionOptions {
                dht: None,
                listen: None,
                persistence: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                fastresume: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let api = Api::new(session, None);
        let mut t = b"d4:infod6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:".to_vec();
        t.extend_from_slice(&[0u8; 20]);
        t.extend_from_slice(b"ee");
        assert!(librqbit::torrent_from_bytes(&t).is_ok());
        let opts = || {
            Some(AddTorrentOptions {
                paused: true,
                ..Default::default()
            })
        };
        let a = api
            .api_add_torrent(AddTorrent::from_bytes(t.clone()), opts())
            .await
            .unwrap();
        let b = api
            .api_add_torrent(AddTorrent::from_bytes(t), opts())
            .await
            .unwrap();
        assert!(a.id.is_some());
        assert_eq!(a.id, b.id);
    }
}
