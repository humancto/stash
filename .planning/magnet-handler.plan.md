# magnet-handler

Roadmap: register stash as the browser's `magnet:` handler; paste a
magnet/URL anywhere to add it; drop a `.torrent` file on the page (user
request 2026-11-21). stash stays on 127.0.0.1 (no auth yet).

## Server

`POST /api/transfers` accepts two bodies, picked by `Content-Type`:

- `application/json` `{ "url": "..." }` (today). Validate: trimmed, starts
  with `magnet:?` (case-insensitive scheme) or `http://` / `https://`, at
  most 8 KiB. Anything else → 400 "Paste a magnet link or a .torrent URL".
  (Today any string goes to librqbit, which also accepts local file paths:
  `AddTorrent::from_url` treats a non-URL as a path. That lets any caller
  make stash read a local file as a torrent. Closing it is part of this
  item.)
- `application/x-bittorrent` raw body → `AddTorrent::from_bytes`. Limit
  16 MiB on this route (`DefaultBodyLimit::max`), empty body → 400.
  Must start with `d` (bencoded dict) else 400 "not a .torrent file".
- Other content types → 415.

Same write guard / `can_add` / `overwrite: true` as today. The response is
unchanged. Duplicate torrent: librqbit returns `AlreadyManaged`; surface as
200 with the existing id (already the case — verify and test).

Handler takes `HeaderMap` + `Bytes` and dispatches; JSON parsed with
`serde_json::from_slice` (400 on error with a short message).

## Web

1. **Add page** `/add?uri=<magnet>` (target of the protocol handler).
   Never adds on load: any web page can navigate a tab here, so the user
   confirms. Shows the `dn` (display name) from the magnet if present, else
   the info hash, plus "Add" (focused) and "Cancel" (→ /files). Invalid or
   missing `uri` → "That isn't a magnet link." + back to Files. On add →
   navigate to /transfers (replace). Writes paused → disabled with reason.
   `parseMagnet(uri)` in `lib/magnet.ts`: `{ name, hash }` or null; accepts
   `magnet:?xt=urn:btih:<40 hex | 32 base32>` (also `btmh`).
2. **Register handler**: on Transfers, a small "Open magnet links with
   stash" button, shown only when `navigator.registerProtocolHandler` exists
   and `window.isSecureContext`. Calls
   `registerProtocolHandler("magnet", `${location.origin}/add?uri=%s`)`.
   Text after click: "Your browser will ask to confirm." (Safari has no
   API: button hidden; README says to use paste/drag there.)
3. **Paste anywhere**: document `paste` listener in Shell. Ignored when the
   target is an editable element (input, textarea, contenteditable). If the
   pasted text (trimmed, single line) is a magnet or an http(s) URL ending
   in `.torrent` (path, ignoring query), it goes into the add box and the
   form submits (same path as typing + Enter, same errors).
4. **Drop a .torrent**: Shell listens for `dragenter/over/leave/drop` on
   the window when the drag contains Files. Overlay "Drop .torrent to add".
   On drop: each file with `.torrent` extension or type
   `application/x-bittorrent`, ≤ 16 MiB, is sent with
   `api.addTorrentFile(file)` (raw body). Other files → error "Only
   .torrent files can be added". Dropped text/uri-list with a magnet → add.
   Then → /transfers. Errors shown in the add form's alert.
5. **Open .torrent button**: hidden `<input type=file accept=".torrent">`
   behind a button next to Add (keyboard/remote reachable), same upload.

`api.addTorrentFile(file: Blob)`: POST with
`content-type: application/x-bittorrent`.

## Edge cases

- Drag of in-page elements (links, images) has no Files → no overlay.
- Overlay `dragleave` flicker: count enter/leave.
- Writes paused → paste/drop show the paused reason, nothing sent.
- Several files dropped: added one by one, first error stops and is shown.

## Tests

Rust: body dispatch (json url, bad scheme / path refused, too long, bytes
ok-shape, not-bencode, empty, wrong content type) as a pure fn
`parse_add(content_type, bytes) -> Result<AddSource, AddError>`.
Live: add a real magnet; add a .torrent via curl `--data-binary`.

Web: parseMagnet table; Add page (no add on load, confirm adds, invalid
uri); paste outside input adds, inside input ignored; drop .torrent calls
addTorrentFile, drop other file errors; register button hidden without API.

## Rollback

Revert the PR. The JSON form keeps working for old clients; a registered
protocol handler pointing at `/add` would then just land on Files.

## Revisions after review (rust-expert + typescript-expert, both REQUEST_CHANGES)

Supersedes the sections above where they conflict.

Server
- Correction: librqbit `from_url` does not read local paths (it bails
  "unsupported URL"; only `from_local_filename`/`from_cli_argument` read
  files). Validation stays for clear messages, not as a hole fix.
- `parse_add(content_type: Option<&str>, body: &[u8]) -> Result<AddSource,
  AddError>` (pure). `AddSource = Url(String) | Bytes(Bytes)`,
  `AddError` thiserror-style enum → `AppError::Message` (JSON
  `human_readable`) for 400 / 413 / 415.
- Content-Type: media type only (split `;`, trim, ASCII case-insensitive).
  Missing → 415. Only `application/json` and `application/x-bittorrent`
  are ever accepted (never text/plain, form or multipart: those are CORS
  safelisted and would bypass the preflight).
- URL: trimmed, ≤ 8 KiB, scheme lowercased before handing on (`magnet:`,
  `http://`, `https://`). A bare 40-hex (or 32 base32) info hash is kept
  working: normalised to `magnet:?xt=urn:btih:<hash>`.
- http(s) `.torrent` URLs are fetched by stash, not librqbit: own reqwest
  client, 30 s timeout, ≤ 5 redirects, body capped at 16 MiB while
  streaming, then `from_bytes`. Errors: "Could not download that .torrent
  (HTTP 404)" / "(timed out)" / "too large"; no echo of internal detail.
  Private/loopback hosts stay allowed (local indexers like Jackett), the
  CSRF/Origin guard keeps other sites from driving it. The fetch uses the
  normal connection, like the browser would; adding is already refused by
  `can_add()` when the kill switch blocks.
- Order: read body → `parse_add` → (fetch) → `write_guard` → `can_add` → add.
  Fetch happens before the write guard so a slow download does not hold it.
- Body limit: `post(add).layer(DefaultBodyLimit::max(16 MiB))` on the method
  router only; handler takes `Result<Bytes, BytesRejection>` and maps 413 to
  JSON. JSON branch rejected early when Content-Length > 8 KiB.
- Bencode: quick `d` check, and librqbit decode errors mapped to 400 "That
  file isn't a valid .torrent".
- Duplicate: 200 with the existing id (librqbit `AlreadyManaged`); new
  options ignored. Integration test: Session in a temp dir (no DHT, no
  listen, no UPnP), same bytes twice → same id.

Web
- One owner for adding: `lib/adder.ts` store (like `transfers`) with
  `add(source: AddSource)`, `AddSource = {kind:"url",url} | {kind:"files",
  files: File[]}`, shared `busy`/`error`/`status`, the writes-paused check
  once. Form, paste, drop, file button and `/add` all call it.
- Files batch: validate all (`.torrent` ext or `application/x-bittorrent`,
  ≤ 16 MiB) before sending; any invalid → whole batch refused. Errors mid
  batch: "Added 2 of 3. name: reason".
- Drop: `document` `dragstart`/`dragend` set an `internalDrag` ref.
  Droppable = `!internalDrag && (Files || text/uri-list)`. When droppable,
  window `dragover`/`drop` always `preventDefault()` first (no navigation
  away), then decide. Overlay: fixed full-viewport, children
  `pointer-events:none`, `aria-hidden`; hidden on its own `dragleave`, on
  drop, on window blur, and when no `dragover` for 250 ms. Fade respects
  reduced motion. uri-list with a magnet or .torrent URL → add url.
- Paste: document listener; skip when `e.defaultPrevented` or
  `isTypingTarget(document.activeElement)` (keys.ts). Handles
  `clipboardData.files` (Finder copy) and text (magnet / bare hash /
  http(s) URL whose path ends `.torrent`). `preventDefault` only when
  handled. On `/watch/*` adds without navigating (status in the alert);
  elsewhere → `/transfers`.
- `/add` route added before `*`. `AddConfirm`: `<h1>Add this torrent?</h1>`,
  name from `dn` (`dir="auto"`, truncated by CSS) and always the info hash
  as text; Add (focused) + Cancel in a `data-rove` group with
  `data-rove-item`; activation ignored for 500 ms after mount (keyjacking).
  The decoded `uri` param is sent as-is (`+`/`%2B` round-trip test).
  Invalid → "That isn't a magnet link." + Back to Files.
- `parseMagnet(uri): { hash, name } | null` via `new URL(...).searchParams`;
  `magnet:?` required; first valid `xt`; btih 40 hex or 32 base32
  (case-insensitive, normalised), btmh `1220` + 64 hex.
- Register handler + "Open .torrent" (visible label, `multiple`, accept
  `.torrent,application/x-bittorrent`, `value=""` reset after change) live on
  Transfers in the main zone as rove items (topbar stays mouse-only, as
  today). Feature check `"registerProtocolHandler" in navigator &&
  isSecureContext`; try/catch; afterwards label "Asked your browser —
  check the address bar" (localStorage flag, try/catch). README: per-origin
  (localhost vs 127.0.0.1 differ), Safari has no API, remove in browser
  settings on rollback.
- After an add navigates to /transfers, focus the page heading.
- `api.addTorrentFile(file)` through `request()`.
- Tests: per the TS review list (dragover prevented incl. paused, internal
  drag no overlay, overlay timeout, mixed batch sends nothing, same file
  twice, paste paused/inside search, /add guard window, hash without dn,
  +/%2B, Add→Cancel arrow), Rust per the rust review list (uppercase
  scheme, charset param, missing type, bare hash, whitespace, 413/415 JSON
  shape). Manual: register + real magnet click in Chrome and Firefox.

## After PR review (rust-expert)

- `.torrent` URL download uses `Privacy::download_route()` (also refused
  while the kill switch has stopped traffic, before the restart).
- No early Content-Length check for JSON: the route limit (16 MiB) bounds it
  and `parse_add` refuses > 8 KiB; stash listens on 127.0.0.1 only.
- `AddError` is a plain enum with `status()`/`message()` (binary crate, no
  `Error` impl needed).
- A download that returns something other than a `.torrent` (login page)
  is a 502 "the server sent something that isn't a .torrent".
