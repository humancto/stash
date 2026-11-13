# web-ui (final, after plan review round 1: typescript-expert + rust-expert, both REQUEST_CHANGES, all points adopted)

## Review round 1 revisions (these override the sections below)

Backend:
- No build.rs. `#[derive(RustEmbed)] #[folder = "web/dist"] #[allow_missing = true]`; when `index.html` is absent serve a compiled-in placeholder page and log a startup warning. Pin current rust-embed (with `mime-guess`), add `tower-http` (`compression-gzip`, `compression-br`, explicit brotli quality) to [dependencies]. Document that debug builds read web/dist from disk.
- Handlers generic over `E: RustEmbed`; Rust tests use a fixture embed at `tests/fixtures/dist` (index.html, assets/app-abc123.js, favicon.svg), so `cargo test` needs no Node.
- Routing: exact embedded file first (covers `public/` root files like favicon.svg), `/assets/*` miss → 404, `/api` and `/api/*` misses → 404 in librqbit ApiError JSON shape, other GET/HEAD → index.html, non-GET/HEAD on SPA paths → 405. Compression via `get(handler).layer(CompressionLayer)` on asset/SPA handlers and `.fallback(...)` (no router merge); `.fallback()` before `.layer(guard)`.
- ETags weak `W/"<sha256>"` (valid across content-codings), `If-None-Match` parsed as list incl. `*`, 304 on match; index.html also gets an ETag with `no-cache`.
- Guard sets `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` with `or_insert` on responses that have none (JSON, assets); index.html sets its own. Range requests with `Accept-Encoding: br` never get `Content-Encoding` (test).
- Tests also cover HEAD, 405, guard headers end-to-end with a Host header.

Frontend:
- One data store (module singleton + `useSyncExternalStore`): chained `setTimeout` 1.5 s, stops when `document.hidden`, refetches on `visibilitychange` to visible; monotonically increasing request sequence, responses older than the newest applied are dropped; a mutation aborts the in-flight poll, then refreshes; a failed poll keeps last good data and sets a `stale` flag (banner with retry).
- Runtime validation at the boundary with hand-written type guards (no extra dep): `id?: number`, `name: string | null`, `files?`, `stats?`, `live: null`, `error: string | null`, `file_progress?: number[]`.
- Per-file status from `stats.file_progress[fid] / length`; `included: false` → "Skipped". State mapping: `initializing`/`initializing_paused` → "Checking"; `live` + file complete → "Ready"; `live` incomplete → "Streaming n%"; `paused` → "Paused" (or "Ready" when the file is complete); `error` → "Error" with `stats.error`. No "Queued".
- `live.download_speed.mbps` is MiB/s; formatter tested against that.
- Error bodies parsed defensively (403 plain text, axum 415/422 rejections); add sends `Content-Type: application/json`.
- Clipboard: `navigator.clipboard?.writeText` → `execCommand('copy')` → select-text fallback (LAN/Tailscale over plain HTTP has no Clipboard API). VLC: `vlc://<url>` link plus `.m3u` download.
- Ambient light: `@property --screen { syntax: '<color>'; inherits: true; initial-value: … }`, full `rgb()` values, CSS transition does the smoothing; all-dark frame keeps previous colour; `getImageData` in try/catch; canvas `willReadFrequently: true`; set via `style.setProperty` only.
- Keyboard: handlers ignore inputs/textareas, a focused `<video>`, and fullscreen (Escape exits fullscreen first). Up/Down roving in lists; Left/Right moves between rail, list and Watch actions so TV users are never stranded.
- Watch handles invalid ids, a transfer deleted mid-view, and navigates to Files after Delete; delete confirm says files are removed from disk.
- Memoised flatten/sort; rows memoised by content. No `aria-live` on per-poll rows.
- Vite `build.assetsInlineLimit: 0`. tsconfig adds `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature`. Router imports from `react-router`; unknown routes `<Navigate replace>`.
- Tests: Vitest + jsdom + fake timers for the store (race/abort/visibility/stale), Testing Library for delete confirm and deep-link routing, plus the pure-function tests. Exact dependency versions, lockfile committed.

Roadmap item (P0): replace `src/index.html` with a Vite + React + TS app in `web/`, embedded in the binary. Views: Files, Transfers, Watch (file page). Mac, phone, TV. Visual direction: **Projection Booth** (owner's choice, 2026-11-12); contract in `.impeccable/surfaces/web-src-app-tsx.md`.

## Scope rules

- Only real backend data. No invented dates, posters, media info, storage numbers or subtitles. Slots for media info / subtitles / HLS are NOT rendered until their roadmap items ship.
- No new backend features except what serving the SPA needs.

## Frontend (`web/`)

- Vite 7 + React 19 + TypeScript (strict, `noUncheckedIndexedAccess`), `react-router` 7 (library mode, `createBrowserRouter`). No UI kit, no CSS framework: plain CSS with custom properties (`tokens.css`), CSS modules not needed (small app; BEM-ish class names).
- Fonts self-hosted via `@fontsource-variable/hanken-grotesk` (no Google fetch; works offline and under CSP).
- Data: `api.ts` typed client for the existing endpoints (types mirror librqbit JSON: `TorrentListResponse`, `TorrentDetailsResponse`, stats with `state`, `progress_bytes`, `total_bytes`, `finished`, `live.download_speed`, `live.snapshot.peer_stats`). `useTransfers()` hook: polls `/api/transfers` every 1.5 s, pauses when `document.hidden`, aborts in-flight fetch on unmount, exposes `{data, error, refresh}`; keyed reconciliation keeps UI state across polls. Mutations (add, pause, start, delete) call then `refresh()`.
- Routes: `/` → redirect `/files`; `/files`; `/transfers`; `/watch/:tid/:fid`. Unknown → Files. Deep links work because the server falls back to `index.html`.
- **Files**: all files across transfers flattened (skip `attributes.padding`/`hidden`), filter tabs All · Video · Audio · Other (by extension), client-side search (`/` focuses), sort: Recently added (transfer id desc, honest proxy) · Name · Size. Row: generated swatch (deterministic hue from name, labelled as generated in code), name, size, format (extension), status (Ready / Streaming n% / Queued / Paused / Error) from transfer stats. Click → Watch.
- **Watch** (`/watch/:tid/:fid`): `<video controls playsInline preload="metadata">` with `src` = stream URL for browser-playable extensions; for others (mkv/avi/…) still attempt playback (Chrome plays many H.264 MKVs) and on `error` show an honest panel: "This browser can't play this format yet. Download it or open it in VLC." Actions rail: Play, Download (`?download=1`), Copy stream link (absolute URL via `navigator.clipboard`, fallback select-text), VLC/IINA playlist (client-generated `.m3u` blob with the absolute stream URL), Go to transfer, Delete transfer (inline two-step confirm, isolated at the bottom of the rail; never `window.confirm`). Transfer progress shown while downloading.
- **Signature move (ambient light)**: while the video plays, every 500 ms draw the current frame into a 16×9 offscreen canvas, average it (skip near-black pixels), smooth with lerp, and set `--screen` (rgb) on the room element; CSS uses it in a radial glow around the player and a faint wash on header and rail edge. Same-origin media so `getImageData` is allowed. Stops when paused/hidden; respects `prefers-reduced-motion` (no animated transitions, colour updates at most every 2 s). Before playback, `--screen` uses the file's generated swatch.
- **Transfers**: rows with reel ring (SVG circle, stroke-dasharray) for progress, name, `progress / total`, speed, peers, state; Pause/Resume; Delete with inline confirm; expandable file list linking to Watch. Add magnet in top bar: input + Add, inline error text from API `human_readable`.
- **Responsive**: ≥1024 rail + content; 600–1023 collapsed icon rail; <600 bottom tab bar, single column, Watch actions under the player. TV/keyboard: all targets ≥44 px, visible amber focus ring (`:focus-visible`), ArrowUp/ArrowDown roving focus in lists, Enter opens, Escape goes back on Watch.
- States: loading skeleton rows (no spinner), empty Files ("Nothing here yet. Paste a magnet link above to start."), API error banner with retry, delete confirm, add error, unplayable format.
- Accessibility: landmarks (`nav`, `main`), `aria-current` on nav, buttons are buttons, progress has `role="progressbar"` + `aria-valuenow`, colour never the only status signal (text label always present), contrast ≥ 4.5:1.

## Backend (`src/`)

- New `src/web.rs`: serves the built SPA embedded with `rust-embed` (`#[folder = "web/dist"]`).
  - `GET /assets/*` → embedded file, `Content-Type` from `mime_guess`, `Cache-Control: public, max-age=31536000, immutable` (Vite hashes asset names), ETag from rust-embed hash, 304 on `If-None-Match`.
  - Other `GET` not under `/api/` → `index.html` with `Cache-Control: no-cache` and CSP: `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  - Unknown `/api/*` → 404 JSON (not index.html).
- `tower-http` `CompressionLayer` (gzip + br) on the static routes only, never on `/api/transfers/*/files/*` (range streaming).
- `build.rs`: if `web/dist/index.html` is missing, create `web/dist/index.html` with a short "UI not built: run `npm --prefix web ci && npm --prefix web run build`" page and print `cargo:warning`, so `cargo build`/`cargo test` work without Node. `cargo:rerun-if-changed=web/dist`.
- Remove `src/index.html` and the `index` handler; keep the guard middleware over everything.
- `Makefile`: `make web` (npm ci + build), `make build` (web then `cargo build --release`), `make test` (cargo + vitest), `make run`.

## Tests

- Vitest (jsdom not needed for pure fns): format bytes/speed, status derivation from stats, file kind by extension, swatch determinism, flatten/filter/sort/search, m3u content, average-colour function on a synthetic ImageData.
- `tsc --noEmit` strict, `vite build`.
- Rust: `web.rs` tests via router `oneshot`: `/` and `/watch/1/2` return index with CSP + no-cache; `/assets/<hashed>` returns immutable cache + correct type; `/api/nope` → 404; ETag 304.
- Live: Playwright at 1440×900, 390×844 and 1920×1080 on a scratch instance with Big Buck Bunny: Files → Watch → playback starts, ambient colour changes, Download link, Transfers pause/resume, delete confirm (on a throwaway transfer), search, keyboard navigation.

Gates: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `npm --prefix web run typecheck`, `npm --prefix web test`, `npm --prefix web run build`.

## Design gates (impeccable)

Read craft-floor before UI edits; run `impeccable detect` on `web/src`; screenshots to `.impeccable/review/`; finish reviewer; documenter writes DESIGN.md + `.impeccable/design.json`.

## Rollback

Squash-merge; `git revert` restores `src/index.html`.
