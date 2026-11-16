# network-status

Show what torrent peers can see: which network interface stash's traffic
leaves on, whether that looks like a VPN tunnel, and the public IP and
country. Read-only. No change to how torrents connect (that is
network-privacy, which adds the kill switch).

Reviewed by rust-expert and typescript-expert (both REQUEST_CHANGES on v1);
all points applied below. Disagreements: none.

## Backend: `src/network.rs`, `GET /api/network`

### Dependencies

- `reqwest = { version = "=0.13.5", default-features = false, features = ["rustls"] }`
  so feature unification does not turn on `system-proxy`/`http2` for
  librqbit's tracker client. Check: `cargo tree -e features -i reqwest`
  shows the same feature set before and after.
- `network-interface = "=2.0.5"` (already in the tree).

### Probe (per family, v4 and v6 run concurrently with `tokio::join!`)

1. **Route.** In one `spawn_blocking` (also runs `getifaddrs`): UDP socket
   bound to unspecified:0, `connect` to two neutral targets per family
   (v4 `1.2.3.4`, `9.9.9.9`; v6 `2001:4860:4860::8888`, `2a00:1450:4001::1`;
   no packets are sent). `local_addr()` is the source IP. Bind failure,
   `ENETUNREACH`, `EADDRNOTAVAIL`, or an unspecified or link-local source → `route: false` (private and CGNAT sources stay valid: VPN tunnel addresses use them).
   `route_consistent: false` if the two targets leave on different
   interfaces (split routes, DNS host routes).
2. **Interface.** Match the source IP against `NetworkInterface::show()`.
   Exactly one match → name; zero or several → `interface: null`.
3. **Tunnel.** `tunnel = !loopback && mac_addr.is_none()` (layer-3 tunnels
   such as utun, tun, wg, nordlynx, proton0 have no hardware address;
   Ethernet and Wi-Fi do), OR the name starts with `utun`, `tun`, `wg`,
   `tailscale`, `nordlynx`, `proton`, `ipsec`, `gpd`, `zt`. Names starting
   with `ppp`, `ww` or `rmnet` are never a tunnel (PPPoE and cellular links are the ISP).
4. **Public IP.** `GET https://1.1.1.1/cdn-cgi/trace` and
   `https://[2606:4700:4700::1111]/cdn-cgi/trace` (IP SANs; a literal
   forces the family). Client: `.no_proxy()`, `redirect::Policy::none()`,
   `connect_timeout(2s)`; whole request + body inside one 4 s
   `tokio::time::timeout`; require status 200; read with `chunk()` and
   stop past 4096 bytes; `from_utf8_lossy`; parse `ip=` and `loc=`.
   Skipped for a family with no route. If the OS routes to the lookup server from a different source than the probe found, the lookup is skipped with "Lookup took a different route". Disabled by `STASH_IP_LOOKUP`
   (`off|0|false|no`, case-insensitive; anything else but `on|1|true|yes`
   logs a warning and stays on), read once at startup.

**Verdict comes from the interface only**; the lookup is informational:
`offline` if no family has a route; `exposed` if any routed family leaves
on a non-tunnel interface (an IPv6 leak counts); else `tunnel`.

### Response (snake_case)

```json
{
  "verdict": "tunnel" | "exposed" | "offline",
  "checked_at": 1763270000,
  "lookup_enabled": true,
  "ipv4": { "route": true, "interface": "utun4", "tunnel": true,
            "route_consistent": true, "local_ip": "10.2.0.2",
            "public_ip": "185.1.2.3", "country": "NL", "error": null },
  "ipv6": { "route": false }
}
```

### Cache

`Arc<NetworkProbe>` holds config (targets, trace URLs, lookup flag,
client) and `tokio::sync::Mutex<Option<Cached>>`, where `Cached` stores
`Instant` and `SystemTime`. Expired if either clock passed the TTL or the
wall clock moved backwards (macOS `Instant` stops during sleep). TTL 30 s;
5 s when any lookup failed. `?refresh=1` forces a probe, but never more
than once every 5 s; inside that window the cached report is returned with
its original `checked_at`. The mutex is held across the probe so
concurrent callers coalesce. If the caller drops mid-probe, nothing is
cached and the next caller starts over (accepted; comment says so).

`// INVARIANT:` comment: the probe matches peer traffic only while
`SessionOptions` has no `bind_device_name` and no SOCKS proxy.
network-privacy must feed the same values into the probe.

Route merged into `api_routes` before `web::attach`, so the guard wraps it.

### Rust tests

- `parse_trace`: normal, CRLF, missing `loc`, junk, `loc=T1`.
- `is_tunnel` table over (name, has MAC, loopback), incl. `ppp0`, `en0`,
  `utun4`, `proton0`, `nordlynx`.
- `verdict` table.
- Loopback route smoke test (`lo0` on macOS, `lo` on Linux).
- Local axum fake trace server on `127.0.0.1:0`: canned body, oversize
  body (capped), 302 (not followed → error), slow body (timeout with a
  short configured timeout), request counter.
- Coalescing: 8 concurrent `report()` calls → 1 fetch.
- TTL and refresh floor with an injected clock.
- `#[ignore]` real-network test of both Cloudflare endpoints.

## Frontend

- `lib/api.ts`: discriminated `Family` union
  (`{route:false} | {route:true; iface: string|null; tunnel; routeConsistent; localIp; publicIp: string|null; country: string|null; error: string|null}`),
  `Verdict = "tunnel"|"exposed"|"offline"`. `parseNetwork` throws `ApiError`
  on a bad envelope. `api.network({ refresh?, signal? } = {})`, URL via
  `URLSearchParams`.
- `lib/network.ts`: store in the style of `store.ts`. Explicit `start()`/
  `stop()`/`visibilityChanged()` from Shell's existing effect (no
  fetch-on-subscribe, StrictMode-safe). Poll every 2 min while visible.
  On becoming visible, poll only if the last check is older than the
  interval. `refresh()` sends `refresh=1`, aborts an in-flight timed poll,
  resets the timer, seq guard like `store.ts`. `check()` (no refresh) is
  used by the panel on mount when the report is older than 30 s.
  Snapshot `{ report, error, loading, refreshing, stale }`;
  `stale = error !== null || now - checked_at > 2 × interval`.
- `components/NetworkChip.tsx` in the rail foot (replaces the tagline).
  No IP in the chip. Words: "VPN tunnel" (sage dot), "No VPN" (coral),
  "Offline", "Checking", "Unknown" (dim; also when stale). Reuses
  `.status-dot`. Accessible name e.g. "Network: no VPN tunnel. View
  details". Links to `/transfers#network`. Icon rail (641–1023 px): icon
  with dot, word visually hidden. Phone: no chip; the panel is on
  Transfers.
- `views/Transfers.tsx`: `NetworkPanel` first on the page, `id="network"`,
  one ruled row: headline + "Checked 14:02" + "Check again" (disabled,
  "Checking…" while in flight) + disclosure (`aria-expanded`) for
  per-family rows. Hash effect on `[location.hash, location.key]`
  scrolls (instant under reduced motion) and focuses the heading
  (`tabIndex={-1}`); `scroll-margin-top` uses the top bar height variable.
- Copy (never "safe", never "your own IP"):
  - tunnel: "Peers see 185.1.2.3 (NL). stash's traffic leaves through
    utun4, which looks like a VPN tunnel."
  - exposed: "Peers see 49.1.2.3 (IN). stash's traffic does not leave
    through a VPN tunnel on the machine running stash."
  - offline: "stash has no internet route right now."
  - Footnote: "Checked for general internet traffic. If the VPN drops,
    stash keeps running and peers see your normal IP."
  - lookup off: "Public IP lookup is off (STASH_IP_LOOKUP)."
  - `route_consistent: false`: "Some traffic takes a different route."
- One visually hidden `role="status"` region announces only verdict
  changes after first load and the result of a user-pressed "Check again".
- DESIGN.md: rail foot is now the network chip; add the network status
  pattern.

### Web tests

- `parseNetwork`: route:false family, unknown verdict, "partial" rejected,
  lookup off with null IPs, non-finite `checked_at`, non-object family.
- Store (fake timers): interval poll, hidden stops, visible does not
  refetch inside the interval, refresh beats in-flight poll and sends
  `refresh=1`, error keeps report + stale, old `checked_at` stale, stop
  aborts.
- Chip: each verdict + loading + stale, accessible name, link target.
- Panel: three verdicts, lookup off, lookup error, busy state, hash effect
  (stub `scrollIntoView`).
- `App.test.tsx`: route the fetch mock by URL; reset the network store.

## README

Document `STASH_IP_LOOKUP` and say plainly: while a stash page is open it
asks Cloudflare for the public IP every 2 minutes (and on "Check again").

## Rollback

Self-contained module, one route, two components. Revert the PR.
