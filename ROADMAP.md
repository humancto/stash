# Roadmap

Ordered by priority. One item per branch and PR, reviewed by the matching expert agent before merge.

## P0: make it work

- [x] **fix-file-list**: `/api/transfers` includes each transfer's files so the UI shows Play/Download; handle suffix ranges (`bytes=-N`) in the stream endpoint.
- [x] **security-hardening**: (1) Serve only audio/video/subtitle MIME types inline; everything else `application/octet-stream` + `Content-Disposition: attachment`; `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` on file responses. (2) Reject unexpected `Host` headers (DNS rebinding) and require same-origin `Origin` on state-changing requests (CSRF). (3) `overwrite: false` by default and session state moved outside the download directory.
- [x] **web-ui**: Replace `src/index.html` with a Vite + React + TS app in `web/`, embedded in the binary. Views: Files, Transfers, File page (player, actions rail, subtitles slot, media-info slot). Works on Mac, phone and TV. Own visual identity, not put.io's.
- [x] **network-status**: Show what torrent peers see: the outbound interface for IPv4 and IPv6, whether it is a VPN tunnel, and the public IP and country. `GET /api/network`, plus a status chip in the rail and a panel on Transfers.
- [x] **network-privacy**: Fixed listen port over TCP + uTP, UPnP toggle, bind torrent traffic to a named interface (VPN kill switch), peer limit, all via env/config. Document VPN + port-forwarding setup. Kill switch levels (strict / warn / off) and a peer IP blocklist (user request 2026-11-16).
- [x] **seeding-policy**: Stop seeding as soon as a download finishes, on by default (first-class rule; user request 2026-11-16). Optional ratio or time limit instead.
- [x] **file-delete**: Delete a single downloaded file (not the whole transfer) from the Files list and the file page: deselect it in the torrent so it is not downloaded again, remove it from disk, confirm first (user request 2026-11-16).
- [ ] **vpn-port-forwarding**: NAT-PMP for Proton and similar VPNs: request and renew the forwarded port, listen on it, follow it when it changes.
- [ ] **auth**: Access control before exposing beyond localhost (login or token), safe for LAN/Tailscale family use. Approach: LAN-only listener plus device pairing with a one-time code (user request 2026-11-21: no logins, local WiFi).

## P1: watch anything

- [ ] **media-info**: ffprobe endpoint (container, codecs, resolution, duration, audio and subtitle tracks), cached; shown on the file page.
- [ ] **hls-remux**: On-demand HLS for MKV/HEVC/AC3: remux video (copy), transcode audio to AAC only when needed, VideoToolbox fallback; seeking works. Stream link, HLS link and VLC/IINA playlist actions.
- [ ] **subtitles**: Serve bundled `.srt` and embedded subtitle tracks as WebVTT; subtitle picker on the file page.
- [ ] **live-events**: Server-Sent Events for transfer progress; the UI stops polling.
- [ ] **stream-prefetch**: Prioritise head and tail pieces of the main video on add; larger read-ahead for high-bitrate files.

## P1.5: library (user request 2026-11-21)

- [x] **magnet-handler**: Register stash as the browser's `magnet:` handler; paste a magnet/URL anywhere to add it; drop a `.torrent` file on the page.
- [ ] **command-palette**: Cmd+K: search files, add a magnet, jump to a page.
- [ ] **folder-zip**: Download a transfer or folder as one zip, streamed on the fly (no temp copy).
- [ ] **library-posters**: Parse film/show names from file names; optional TMDB lookup (off by default, user key) for posters, titles, seasons; a poster Library view next to Files.
- [ ] **pwa**: Web app manifest and home-screen install; full-screen playback; service worker only where the page is a secure context.

## P2: polish

- [ ] **thumbnails**: Generate and cache a frame per video for the Files list.
- [ ] **watch-state**: Watched/unwatched, resume position, history.
- [ ] **seedbox-deploy**: Docker image + gluetun/VPN compose file for running stash on a remote box.
- [ ] **desktop-shell**: Tauri wrapper around the same web build.

## P3: beyond put.io (user request 2026-11-21)

- [ ] **auto-cleanup**: Delete watched files after N days, or keep disk use under a cap (oldest watched first). Off by default.
- [ ] **notifications**: ntfy / Telegram message when a download finishes.
- [ ] **rss-feeds**: Follow RSS feeds, auto-add items that match a rule, skip duplicates.
- [ ] **subtitle-search**: OpenSubtitles lookup by file hash for files without subtitles (user key).
- [ ] **share-links**: Expiring, read-only stream links for one file.
- [ ] **swarm-view**: Live speed graph, peers by country, bandwidth schedule.
- [ ] **cast**: Chromecast button; DLNA/UPnP media server so TVs and VLC find stash on the LAN.
- [ ] **watch-party**: Two browsers play the same file in sync (play, pause, seek).
- [ ] **trakt-sync**: Scrobble to Trakt and sync watched state (user key).
