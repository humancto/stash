# stash

A personal put.io-style box: one Rust binary with a torrent engine
([librqbit](https://github.com/ikatson/rqbit), Apache-2.0), an HTTP API and a web UI.

## Build and run

Needs Rust and Node.js (for the web UI).

    make build    # npm ci + Vite build of web/, then cargo build --release
    make run      # build, then start the release binary
    make test     # cargo test, then the web UI tests

Open http://127.0.0.1:3030, paste a magnet link, and press Play on a file.
Playback works while the torrent is still downloading.

The web UI source is in `web/`. `make web` builds it into `web/dist`.

- Release builds embed `web/dist` in the binary. Run `make build` after you change the UI.
- Debug builds (`cargo run`) read `web/dist` from disk on each request. Run `make web` and reload the page; you do not need to rebuild stash.
- If `web/dist/index.html` does not exist, stash still starts. The API works, every app page shows "UI not built — run `make web`", and stash logs a warning at startup. `cargo build` and `cargo test` do not need Node.

| Env var      | Default          | Meaning                                         |
|--------------|------------------|-------------------------------------------------|
| `STASH_DIR`  | `./downloads`    | Where files and session state are stored        |
| `STASH_ADDR` | `127.0.0.1:3030` | Listen address. There is no auth, so keep it local or behind Tailscale |
| `STASH_STATE_DIR` | `./stash-state` | Session state (transfer list, resume data). Must be outside `STASH_DIR`. State in the old `<STASH_DIR>/.session` is moved here on first start. Because the default is relative, `STASH_DIR` can't be `.` or a parent of the working directory unless `STASH_STATE_DIR` is set elsewhere |
| `STASH_ALLOWED_HOSTS` | (none) | Comma-separated host names accepted in the `Host` header besides IP addresses and `localhost`, e.g. a Tailscale MagicDNS name |
| `STASH_IP_LOOKUP` | `on` | `off` stops stash asking Cloudflare for its public IP. The network status then shows only the interface |

## Network status

The rail and the top of Transfers show what torrent peers can see: the interface stash's traffic leaves on, whether it looks like a VPN tunnel, and the public IP and country.

- The interface comes from the operating system's route for general internet traffic, checked per IPv4 and IPv6. An interface with no hardware address (utun, tun, wg, …) counts as a tunnel. If either family leaves on a normal interface, the status is "No VPN", because an IPv6 leak shows your address too.
- The public IP comes from `https://1.1.1.1/cdn-cgi/trace` (and the IPv6 equivalent). Cloudflare sees your IP, as any website does. While a stash page is open, stash checks every 2 minutes, when you open Transfers (if the last check is older than 30 s) and when you press "Check again". The server caches the answer for 30 s. Set `STASH_IP_LOOKUP=off` to stop it.
- This is a status, not protection. If the VPN drops, stash keeps running on your normal connection. A kill switch is on the roadmap (network-privacy).

## Security

- Requests whose `Host` is not an IP address, `localhost` or in `STASH_ALLOWED_HOSTS` get `403` (blocks DNS rebinding).
- `POST`/`DELETE` from another origin get `403` (blocks CSRF).
- The web UI is served with a strict `Content-Security-Policy` (scripts, styles and fonts from the same origin only). Other responses get `default-src 'none'` unless they set their own.
- Torrent files are untrusted. Only video, audio and raster images play inline; everything else (HTML, SVG, PDF, subtitles, …) is sent as a download inside a CSP sandbox. Add `?download=1` to any file URL to force a download.

## API

| Method | Path                                   | Purpose                               |
|--------|----------------------------------------|---------------------------------------|
| GET    | `/api/transfers`                       | List transfers with progress          |
| POST   | `/api/transfers` `{"url": "magnet:…"}` | Add a magnet link or .torrent URL     |
| GET    | `/api/transfers/{id}`                  | One transfer and its files            |
| POST   | `/api/transfers/{id}/pause` · `/start` | Pause / resume                        |
| DELETE | `/api/transfers/{id}`                  | Remove the transfer and its files     |
| GET    | `/api/transfers/{id}/files/{n}`        | Stream (HTTP range); `?download=1` forces a download |
| GET    | `/api/network`                         | What peers see (interface, tunnel, public IP); cached 30 s, `?refresh=1` forces a check (at most every 5 s) |

Unknown `/api` paths return a `404` JSON error. Every other `GET` path returns the web UI, so app links such as `/watch/1/0` work when you open them directly.

## Not built yet

- ffmpeg remux/transcode for MKV, HEVC and other formats browsers won't play
- Stop-seeding policy (it currently seeds until paused or deleted)
- Tauri desktop shell
