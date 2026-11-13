# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Rust binary (axum HTTP API + librqbit torrent engine) serving a Vite + React + TypeScript single-page app, built to static files and embedded in the binary. Chosen 2026-11-12: the owner asked for a framework with a build step and suggested Next.js; Vite + React was picked because Rust is the server (no Node runtime needed) and the same static bundle can later be wrapped in a Tauri desktop app.

## Users

- The owner, on a Mac browser (Safari/Chrome), adding transfers and watching.
- The owner on a phone, over LAN or Tailscale.
- Family members on the home network who browse and play.
- A TV / big screen used for playback.

## Product Purpose

A personal, self-hosted replacement for put.io: paste a magnet link or .torrent URL, the box fetches it, and the files are immediately browsable and playable in the browser, including while still downloading. Success: from paste to first video frame as fast as the swarm allows, on any screen in the house.

## Positioning

Same job as put.io, but the box is yours: one binary, your disk, no cloud account, no storage quota. Streaming reads straight from the torrent with piece prioritisation, so playback and seeking work before the download finishes.

## Operating Context

- Add: paste magnet / .torrent URL.
- Watch: Files list → file page with player, actions, subtitles, media info.
- Manage: Transfers list with progress, pause/resume, delete.
- Share out: stream link, HLS link, VLC/IINA playlist, download.

## Capabilities and Constraints

- Confirmed today: add, list, pause/resume, delete, HTTP-range streaming of browser-native formats.
- Wanted (owner, 2026-11-12): MKV/HEVC playback in browser (ffmpeg remux/transcode), subtitles (bundled .srt and embedded tracks), media info (ffprobe), stream/HLS links and VLC playlist.
- No auth exists yet; must exist before anything is exposed beyond localhost.
- Privacy: torrent traffic must be bindable to a VPN interface (kill switch). librqbit has no protocol encryption (MSE/PE).
- ffmpeg 8 is installed on the owner's Mac.
- Undecided: VPN provider; whether to run on a remote seedbox/VPS; Tauri desktop shell (later).

## Brand Commitments

Name: stash. Structure may follow put.io (sidebar, Files, Transfers, file page with action rail); the look must be stash's own: no put.io wordmark, colours or identity.

## Evidence on Hand

No posters, artwork or metadata service. Thumbnails do not exist until generated from video frames. Do not invent "added N days ago" dates or artwork the backend does not provide.

## Product Principles

1. Time to first frame is the product. Every feature is judged by whether it makes watching start sooner or stay smoother.
2. Works on every screen in the house: Mac, phone, TV.
3. Private by default: local-only until auth exists; torrent traffic stays on the VPN when configured.
4. One binary, no cloud.
