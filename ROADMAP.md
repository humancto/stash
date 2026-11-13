# Roadmap

Ordered by priority. One item per branch and PR, reviewed by the matching expert agent before merge.

## P0: make it work

- [ ] **fix-file-list**: `/api/transfers` includes each transfer's files so the UI shows Play/Download; handle suffix ranges (`bytes=-N`) in the stream endpoint.
- [ ] **security-hardening**: (1) Serve only audio/video/subtitle MIME types inline; everything else `application/octet-stream` + `Content-Disposition: attachment`; `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` on file responses. (2) Reject unexpected `Host` headers (DNS rebinding) and require same-origin `Origin` on state-changing requests (CSRF). (3) `overwrite: false` by default and session state moved outside the download directory.
- [ ] **web-ui**: Replace `src/index.html` with a Vite + React + TS app in `web/`, embedded in the binary. Views: Files, Transfers, File page (player, actions rail, subtitles slot, media-info slot). Works on Mac, phone and TV. Own visual identity, not put.io's.
- [ ] **network-privacy**: Fixed listen port over TCP + uTP, UPnP toggle, bind torrent traffic to a named interface (VPN kill switch), peer limit, all via env/config. Document VPN + port-forwarding setup.
- [ ] **auth**: Access control before exposing beyond localhost (login or token), safe for LAN/Tailscale family use.

## P1: watch anything

- [ ] **media-info**: ffprobe endpoint (container, codecs, resolution, duration, audio and subtitle tracks), cached; shown on the file page.
- [ ] **hls-remux**: On-demand HLS for MKV/HEVC/AC3: remux video (copy), transcode audio to AAC only when needed, VideoToolbox fallback; seeking works. Stream link, HLS link and VLC/IINA playlist actions.
- [ ] **subtitles**: Serve bundled `.srt` and embedded subtitle tracks as WebVTT; subtitle picker on the file page.
- [ ] **live-events**: Server-Sent Events for transfer progress; the UI stops polling.
- [ ] **stream-prefetch**: Prioritise head and tail pieces of the main video on add; larger read-ahead for high-bitrate files.

## P2: polish

- [ ] **seeding-policy**: Stop seeding at a ratio or after a time limit.
- [ ] **thumbnails**: Generate and cache a frame per video for the Files list.
- [ ] **watch-state**: Watched/unwatched, resume position, history.
- [ ] **seedbox-deploy**: Docker image + gluetun/VPN compose file for running stash on a remote box.
- [ ] **desktop-shell**: Tauri wrapper around the same web build.
