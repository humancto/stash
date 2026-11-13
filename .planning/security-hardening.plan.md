# security-hardening (final, after rust-expert plan review round 1)

## Review round 1 changes

- Keep `overwrite: true`: `false` breaks Start on an errored torrent (re-runs create_and_init -> create_new fails "file exists") and retrying a partially-failed add. Moving the state dir out of the download dir removes the `.session` attack on its own.
- Migration: `create_dir_all(state)` first; then cases: only old exists -> rename; both exist -> refuse to start with a loud error; rename error (e.g. EXDEV) -> error with manual-move instructions; reject state == download dir or state inside it (canonicalize after creating both). Log at warn.
- File-response CSP is plain `sandbox` (no fetch directives) so direct playback in a tab works; verify in Chromium.
- Implementation finding: even plain `sandbox` breaks direct-tab playback in Chromium (opaque origin -> media viewer load blocked). Inline types (media + raster images only, nosniff) get `frame-ancestors 'none'` without `sandbox`; every download keeps `sandbox; frame-ancestors 'none'`. Verified with Playwright.
- Clickjacking: `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` on `/`; `nosniff` on every response.
- Host: fall back to `uri().authority()` when no Host header (HTTP/2). Accept exactly `localhost` (no trailing dot / subdomains). Parse bracketed IPv6 before stripping the port.
- Origin on unsafe methods must match Host (case-insensitive, default ports normalised) AND its host must pass `host_allowed`.
- `?download=1` via `Query<Opts>` with `Option` field; never 400 on playback.
- Header values from file names via fallible construction, never `expect`.
- Dev-deps: `tower` (util) and `http-body-util` for router `oneshot` tests.
- Rejection status: 403 with text body; documented in README.

Roadmap item (P0): fix the three findings from the automated security review of the initial import.

## Threats

1. **Stored XSS via torrent content.** `stream` sets `Content-Type` from the file extension (`mime_guess`) and serves inline on the app origin. A torrent containing `x.html` / `x.svg` / `x.xhtml` runs script on `http://127.0.0.1:3030`, with full access to the unauthenticated API (delete everything, add arbitrary torrents).
2. **DNS rebinding / CSRF.** No `Host` check: `evil.example` re-pointed to 127.0.0.1 can read and drive the API from the victim's browser. No `Origin` check: a cross-site `<form method=post action=http://127.0.0.1:3030/api/transfers/0/pause>` works (no body, simple request, no preflight).
3. **Session state inside the download dir with `overwrite: true`.** A multi-file torrent named `.session` writes to `downloads/.session/…` and may overwrite `session.json` / `*.torrent` / `*.bitv`, injecting transfers on next start.

## Changes (src/main.rs, README.md)

### 1. File responses

- Inline allowlist by MIME from `torrent_file_mime_type`: `video/*`, `audio/*`, and raster images `image/{jpeg,png,gif,webp,avif}`. Everything else (incl. `image/svg+xml`, `text/*`, `application/*`, unknown) is served as `application/octet-stream` with `Content-Disposition: attachment`.
- `?download=1` query forces `attachment` for any type (Download link uses it).
- `Content-Disposition` carries the file's last path component as RFC 6266/8187 `filename*=UTF-8''<pct-encoded>` (attr-char set only) plus an ASCII-only `filename="…"` fallback with `"`/`\`/control chars replaced by `_`.
- On every file response (200/206/416): `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; media-src 'self'; img-src 'self'`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`.
- Pure fns with tests: `is_inline_safe(mime) -> bool`, `content_disposition(kind, filename) -> String`.

### 2. Host / Origin middleware (axum `middleware::from_fn_with_state`)

- **Host allowlist:** accept if the `Host` header's host part is an IP literal (v4 or bracketed v6; rebinding needs a DNS name), or `localhost`, or in `STASH_ALLOWED_HOSTS` (comma-separated, case-insensitive, for e.g. a Tailscale MagicDNS name). Port is not checked (proxies). Missing/invalid Host → 400. Rejected → 421 Misdirected Request? No: use **403** with a short text body, simpler for clients.
- **Origin on unsafe methods** (anything except GET/HEAD/OPTIONS): if `Origin` is present it must equal `http(s)://<Host header>`; `Origin: null` rejected. If `Origin` is absent, reject when `Sec-Fetch-Site` is present and not `same-origin`/`none`; otherwise allow (curl/CLI).
- Applies to all routes including `/`.
- Pure fns with tests: `host_allowed(host_header, extra) -> bool`, `origin_ok(method, origin, sec_fetch_site, host) -> bool`.

### 3. State dir and overwrite

- New `STASH_STATE_DIR` (default `./stash-state`, sibling of the default download dir, never inside it). Session persistence goes to `<state>/session`.
- Refuse to start if the state dir is inside the download dir (canonicalized prefix check) — config error message.
- **Migration:** if `<STASH_DIR>/.session` exists and `<state>/session` does not, `rename` it (fallback: error telling the user to move it). Logged at info. The owner's current transfers live in `downloads/.session`, so this must work.
- `overwrite` stays `true` (see review round 1).

## Tests

- Unit: `is_inline_safe` table (mp4, mkv→`video/x-matroska`, mp3, jpeg, svg → false, html → false, xhtml, pdf, text/plain, js, octet-stream).
- Unit: `content_disposition` (ASCII, unicode, quotes/backslash/newline, path components).
- Unit: `host_allowed` (127.0.0.1:3030, [::1]:3030, 192.168.1.5, localhost, LOCALHOST:1, evil.com, evil.com:3030, allowlisted name, empty, garbage `a b`).
- Unit: `origin_ok` (GET passes regardless; POST same-origin; POST cross-origin; POST `null`; POST no Origin + Sec-Fetch-Site cross-site; no Origin + none; no Origin no SFS).
- Integration (tower `oneshot` on the router with a stub handler — no torrent session): Host evil.com → 403; cross-origin POST → 403; same-origin POST → 200.
- Live (recorded in PR): `.html` file in a test torrent is not available — instead test via the poster.jpg (inline, image/jpeg) and the `.srt` (`application/x-subrip` → attachment) in Big Buck Bunny; `?download=1` on mp4 → attachment; `curl -H 'Host: evil.com'` → 403; migration from a scratch `downloads/.session`.

Gates: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

## Out of scope

Authentication (auth item). CORS stays absent (same-origin only).

## Rollback

Single squash commit; `git revert`. If migration ran, moving `stash-state/session` back to `downloads/.session` restores the old layout.
