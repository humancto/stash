# stash

A personal put.io-style box: one Rust binary with a torrent engine
([librqbit](https://github.com/ikatson/rqbit), Apache-2.0), an HTTP API and a web UI.

**A learning project.** stash shows how a BitTorrent client is put together: a peer-to-peer engine, streaming files while they download (HTTP range requests over pieces), a web UI that works on a phone and a TV, and the privacy side of P2P (what peers can see, a VPN kill switch that follows the tunnel, a peer blocklist). It is a personal tool, not a product.

**Legal use only.** Use it for content you have the right to download and share: public-domain films (the test torrents here are Blender's open movies), Linux images, your own files. BitTorrent shows your IP address to every peer; the Privacy page and kill switch reduce that, they don't make anything legal. No license is granted yet: you can read the code, but not reuse it.

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
| `STASH_VPN` | `strict` | Kill switch. `strict`: without a VPN, no torrent traffic. `warn`: without a VPN, torrents use your normal connection (red warning). `off`: never tie torrents to a VPN (e.g. a router VPN). An interface name (e.g. `wg0`) makes only that interface count as the VPN. Overrides the Privacy page |
| `STASH_BLOCKLIST` | daily list | Peer IP blocklist: `off`, `on`, a URL or a file (P2P format, plain or gzip). Default: [Naunter/BT_BlockLists](https://github.com/Naunter/BT_BlockLists). Overrides the Privacy page |
| `STASH_LISTEN_PORT` | (none) | Accept incoming peers on this port (TCP and uTP). With a VPN, use the port it forwards |
| `STASH_UPNP` | `off` | Open the listen port on your router with UPnP. Ignored while the kill switch is on |
| `STASH_PEER_LIMIT` | librqbit's | Maximum peers per transfer |
| `STASH_SEEDING` | `stop` | When to stop sharing a finished transfer: `stop` (as soon as it finishes), `ratio:1.5` (after uploading 1.5× its size), `time:24h` / `90m` / `7d` (that long after it finished), `forever`. Overrides the Privacy page |
| `STASH_IP_LOOKUP` | `on` | `off` stops stash asking Cloudflare for its public IP. The network status then shows only the interface |

## Privacy: kill switch and blocklist

The **Privacy** page shows the path torrent traffic takes (stash → interface → what peers see) and holds the settings. Settings are saved in `<STASH_STATE_DIR>/settings.json`; an env var wins over the page.

- **Kill switch (default: strict).** stash finds the VPN by itself: the interface that carries internet traffic, if its name is a known tunnel (`utun`, `tun`, `wg`, `tailscale`, `nordlynx`, `proton`, `ipsec`, `gpd`, `zt`). Torrent traffic (peers, trackers, DHT) is bound to that interface only. VPN apps make a new tunnel on every reconnect, so stash checks every 3 seconds. When the tunnel goes away or changes, torrents stop at once; when the new state has held for a few seconds, stash restarts itself (about 2 s without the web UI) bound to the new tunnel. Without a VPN, `strict` runs with no networking at all (no DHT, trackers or local discovery), and files on disk still play.
- **Breaking change:** before this version stash used whatever connection the Mac used. If you torrent without a VPN, set `STASH_VPN=warn` or `off`, or pick Warn/Off on the Privacy page.
- **Local discovery is off** whenever the kill switch is on (it announces what you download to your LAN), and the DHT keeps its own identity in `<STASH_STATE_DIR>/dht-vpn.json`.
- **Blocklist (default: on).** stash downloads the list once a day (never while the kill switch has stopped traffic) into `<STASH_STATE_DIR>/blocklist` and loads it when it starts. A new list applies after a restart; the Privacy page has "Restart to apply". It is a filter, not protection.
- **VPN on your router:** the Mac only sees Wi-Fi, so use Off.

## Seeding

By default stash stops sharing a transfer as soon as it finishes: it pauses it (the file still plays and downloads keep working). Peers still get pieces from you while it downloads; that is how BitTorrent works. Seeding longer helps others finish and keeps your address visible to peers for longer.

- Choose on the Privacy page or with `STASH_SEEDING`: stop when finished, until a ratio, for a while, or keep seeding. Changing it applies at once, no restart.
- "Seed" on a finished transfer shares it again; if the rule had stopped it, the rule then leaves it alone until you pause it. Under a ratio or time limit that isn't reached yet, the rule still applies.
- stash keeps its own upload total per transfer (librqbit's resets on every pause and restart) in `<STASH_STATE_DIR>/seeding.json`. Time limits count wall-clock time since stash first saw the transfer finished; for transfers that were already finished before this version, that is from the upgrade.
- **Upgrade note:** transfers that were finished and seeding stop seeding a few seconds after you start this version, unless you pick "Keep seeding".

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
