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
- "Seed" on a finished transfer shares it again; if the rule had stopped it, the rule then leaves it alone until you pause it. Under a ratio or time limit that isn't reached yet, the rule still applies. A transfer you chose to Seed stays seeding if you change the rule later; pause it to put it back under the rule.
- stash keeps its own upload total per transfer (librqbit's resets on every pause and restart) in `<STASH_STATE_DIR>/seeding.json`. Time limits count wall-clock time since stash first saw the transfer finished; for transfers that were already finished before this version, that is from the upgrade.
- **Upgrade note:** transfers that were finished and seeding stop seeding a few seconds after you start this version, unless you pick "Keep seeding".
- **Residual window:** librqbit resumes transfers when the session opens, and the rule's first check runs right after. A finished transfer can announce itself for a moment in between. stash records "finished" to disk at once so this window stays short, and pauses persist, so it only applies to transfers that were seeding when stash stopped.

## Library

The home page is a poster Library of the films and shows stash recognises in your file names (`Show.S01E02…`, `Film (2019) 1080p…`, season folders, anime numbering, site-prefixed names). Each title gets a typographic poster in its own colour; the newest playable one is in the spotlight.

- A title page lists a film's versions (best quality first for Play) or a show's seasons and episodes. Play starts the best ready file, or streams one that is still downloading.
- Filter by Films/Shows and Ready/Downloading, sort, or search (the search box searches the Library everywhere except Files).
- "Hide from Library" removes a title from the posters (the files stay in Files); "Hidden (n)" at the bottom brings it back.
- Nothing leaves your machine: names are read locally. Posters and details from TMDB are planned and will be off unless you turn them on.
- `<STASH_STATE_DIR>/library.json` keeps when stash first saw each transfer (for "Recently added") and what you hid.

## Adding

- **Paste** a magnet link, an info hash or a `.torrent` URL in the add box, or anywhere on the page outside a text field. A `.torrent` file copied in Finder can be pasted too. On a file page, stash adds it and keeps playing.
- **Drop** `.torrent` files, or a magnet link dragged from another app or tab, anywhere on the page. **Open .torrent** on Transfers picks files from disk (up to 16 MB each).
- **Magnet links in the browser:** on Transfers, "Open magnet links with stash" asks the browser to send `magnet:` links to stash (Chrome, Edge, Firefox; Safari has no such option). Chrome asks with a small icon in the address bar. Clicking a magnet link then opens stash's "Add this torrent?" page; nothing is added until you press Add torrent. The browser remembers this per address, so `localhost:3030` and `127.0.0.1:3030` count separately. Remove it in the browser's settings (Chrome: Settings → Privacy and security → Site settings → Additional permissions → Protocol handlers).
- `.torrent` URLs are downloaded by stash (30 s, 5 redirects, 16 MB). The download obeys the kill switch: refused while it blocks, and sent through the VPN when torrent traffic uses one. Links to this machine (a local indexer such as Jackett) go direct and may not redirect elsewhere while the VPN is required; a redirect to a magnet link is used as the magnet. Two limits: a local indexer fetches from its trackers over its own connection, so put it behind the VPN too if trackers must not see your IP; and name lookups for the download use the system resolver, as the blocklist download does.

## Deleting one file

Each row in Files, and the file page, can delete one file of a transfer: stash stops downloading it and removes it from disk at once (the space comes back even while the transfer is running). The last remaining file deletes the whole transfer instead.

- A torrent's data is cut into pieces, and a piece often holds the end of one file and the start of the next. BitTorrent can't forget pieces without checking them, so the next time stash starts, it rechecks that transfer once (its files can't play until the check ends; on a large transfer that takes a few minutes).
- That check loses the piece the deleted file shared with a kept neighbour. If the seeding rule had stopped the transfer, stash starts it again to fetch that piece, and the rule stops it once it is complete.
- Because of that shared piece, a small leftover can stay at the deleted file's path. Finder may show it at full size, but it holds about one piece of data. A deleted file that shares no piece is removed completely.
- If the file has other hard links (for example in a media library), only stash's name is removed; the data stays.
- Progress is kept in `<STASH_STATE_DIR>/seeding.json`, so a delete interrupted by a crash or restart is finished on the next start.

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
| POST   | `/api/transfers` `{"url": "magnet:…"}` | Add a magnet link, info hash or .torrent URL (JSON) |
| POST   | `/api/transfers` (`application/x-bittorrent`) | Add a `.torrent` file (raw body, up to 16 MB); `413` when larger, `415` for other content types |
| GET    | `/api/transfers/{id}`                  | One transfer and its files            |
| POST   | `/api/transfers/{id}/pause` · `/start` | Pause / resume                        |
| DELETE | `/api/transfers/{id}`                  | Remove the transfer and its files     |
| GET    | `/api/transfers/{id}/files/{n}`        | Stream (HTTP range); `?download=1` forces a download; `410` for a deleted file |
| DELETE | `/api/transfers/{id}/files/{n}`        | Delete one file: `{"freed_bytes": n}`; `409` while checking or for the last file |
| GET    | `/api/library`                         | Films and shows recognised in file names (titles, files, quality) |
| POST / DELETE | `/api/library/{key}/hide`       | Hide / unhide a title in the Library  |
| GET    | `/api/network`                         | What peers see (interface, tunnel, public IP); cached 30 s, `?refresh=1` forces a check (at most every 5 s) |

Unknown `/api` paths return a `404` JSON error. Every other `GET` path returns the web UI, so app links such as `/watch/1/0` work when you open them directly.

## Not built yet

- ffmpeg remux/transcode for MKV, HEVC and other formats browsers won't play
- Tauri desktop shell
