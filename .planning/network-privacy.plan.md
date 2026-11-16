# network-privacy

Roadmap: fixed listen port (TCP + uTP), UPnP toggle, bind torrent traffic
to the VPN (kill switch), peer limit, all via env. Document VPN setup.

Verified on this Mac (2026-11-16): Proton VPN (free) connects as `utun6`
(10.2.0.2), default route via utun6, no IPv6 route. Proton picks a new
`utunN` on each reconnect.

## The problem with a plain `bind_device_name`

librqbit 9.1 resolves `bind_device_name` to an interface **index** once, in
`Session::new_with_opts` (`BindDevice::new_from_name` → `if_nametoindex`),
and binds DHT, uTP, TCP listen/connect, UDP trackers and the HTTP tracker
client to it. Consequences:

- Name missing at start → `Session::new_with_opts` fails → stash won't start.
- VPN reconnects (new `utunN`, or same name with a new index) → every
  socket stays bound to the dead index. Traffic stops (good: no leak) but
  never resumes until stash restarts.

## Design (v2, after rust-expert review): stop at once, then re-exec

Rebuilding a librqbit Session in-process is unsafe (review findings 1–5):
UDP/uTP/DHT sockets stay bound until the old Session Arc drops
(EADDRINUSE), open streams pin old torrents whose bitfield flusher writes
stale snapshots, and late writers can flush the old JSON store over the new
one. Instead stash **re-executes itself** (`execv(current_exe, args)`):
std/socket2 sockets are CLOEXEC, so every fd closes and the new process
starts clean. Cost: ~1–2 s with no web UI; players reconnect.

### Kill switch levels: `STASH_VPN` (user asked for levels, 2026-11-16)
The VPN tunnel is detected automatically in every level; the level only
decides what happens when there is no tunnel.
- `strict` (**default**): no tunnel → blocked session (no P2P at all).
- `warn`: no tunnel → normal unbound session; the panel and chip show the
  red "No VPN" warning. With a tunnel, still bound to it (so a VPN drop
  stops traffic immediately, then re-execs unbound).
- `off`: never bind (e.g. a VPN on the router).
- `<name>` (e.g. `wg0` on Linux, where names are stable): like `strict`
  but only that interface counts as the VPN.
Desired binding is one of `Bound{name,index}` / `Blocked` / `Unbound`.

### Choosing the binding (fail closed)
Reuse `network::route_family` (UDP connect source, not "the default
route": WireGuard/OpenVPN on macOS use 0/1 + 128/1). The route's interface
is accepted only if:
- `strict`/`warn`: its **name** matches a strict tunnel prefix (`utun`, `tun`, `wg`,
  `tailscale`, `nordlynx`, `proton`, `ipsec`, `gpd`, `zt`); the display
  rule's "no MAC" fallback is NOT used here (fails open),
- `<name>`: it equals the configured name,
- and the route is consistent across both probe targets.
Otherwise: **blocked**.

### Blocked session (no networking at all)
`dht: None`, `disable_trackers: true`, `disable_local_service_discovery:
true`, `listen: None`, plus `bind_device_name = lo0/lo` as a second layer.
No DNS lookups for trackers or DHT bootstrap can leak. Files on disk still
stream; the UI shows "Kill switch: no VPN, torrents are stopped".

### Bound session
`bind_device_name = <tunnel>`, LSD always off when `STASH_VPN != off`
(it multicasts info-hashes on the LAN), DHT persistence moved to
`<state>/dht-vpn.json` (a node ID seen from both the real and the VPN IP
links them; also avoids sharing rqbit's global cache).

### Supervisor (tokio task, every 3 s, only when `STASH_VPN != off`)
State: `{ binding: Bound{name,index} | Blocked, stopped: bool,
stable_ticks, started_at }`. Pure decision function, unit tested.
- **Stop immediately (no debounce)** when bound and any of:
  `if_indextoname(index) != name` (index reused, e.g. by USB Ethernet), the
  route no longer leaves through `name`, the route is not a tunnel.
  → `session.stop()` (pauses in memory only; the persisted paused flag is
  unchanged, verified in source) and mark `stopped` so the panel shows
  "Reconnecting".
- **Restart (debounced)**: when the desired binding differs from the
  current one for 2 consecutive ticks AND at least 30 s since this process
  started (flap guard), stop (if not already) then re-exec.
- Blocked → tunnel appears: debounced restart (no stop needed, nothing
  is leaking).
- Startup: binding computed before the first session. If
  `Session::new_with_opts` fails for a bound interface (it vanished, or
  Linux < 5.7 without CAP_NET_RAW), log a clear error naming `STASH_VPN`
  and start blocked.

### Writes while stopped (review v2, bug 1)
`accepting_writes: AtomicBool` (Acquire/Release) on the supervisor. While
the session is stopped (immediate stop → re-exec), `add`/`start`/`pause`/
`delete` return 503 + `Retry-After: 3`. Write handlers hold a
`tokio::sync::RwLock<()>` read guard; before exec the supervisor takes the
write guard with a 5 s timeout (exec anyway on timeout; tmp+rename keeps
the store consistent).

### exec (review v2, bug 3)
`Command::new(current_exe()).args(args_os().skip(1)).exec()` (env and
args inherited). On failure: stay stopped, writes blocked, `error!` naming
the cause (e.g. binary replaced), panel state `blocked`, retry with
backoff (5 s → 60 s). Never resume the old session.

### Blocklist fetch rules (review v2)
Absolute path: `Url::from_file_path(state.canonicalize()?.join("blocklist"))`
(or `IpRanges::load_from_file` if public). Fetch only when the binding is
`Bound` or `Unbound`, never when `Blocked`; start from the cache, refresh in
the background.

### Strict default is a behaviour change
Startup log line when strict and no tunnel ("STASH_VPN=strict: no VPN
tunnel, torrents stopped; set STASH_VPN=warn or off"), README section,
CHANGELOG entry. `warn` copy must say plainly that torrents resume on your
real IP when the VPN drops.

### Network status integration
`/api/network` adds `kill_switch: { mode, bound_to, state:
"bound"|"blocked"|"reconnecting"|"off", listen_port, accepting_writes }` from the
supervisor. Panel adds one line; chip shows "Stopped" (muted) when
blocked/reconnecting (peers see nothing).

### Peer IP blocklist: `STASH_BLOCKLIST`
**On by default** (user: "get a blocklist that gets updated every day and
stash does this"). Default source:
`https://raw.githubusercontent.com/Naunter/BT_BlockLists/master/bt_blocklists.gz`
(Transmission/P2P format `name:a.b.c.d-e.f.g.h`, ~596k ranges, 7.9 MB gz,
Unlicense, commits daily as of 2026-11-16; verified that the line format
matches librqbit's `parse_ip_range`). `off` disables; a URL or path
replaces the source. Stash refreshes the cache once a day in the
background; a new list takes effect on the next start (the supervisor's
re-exec also picks it up). Never re-exec just for the list (would cut
streams).
Format: URL (http/https) or local path to a P2P-format list (plain or gzip;
librqbit `IpRanges` parses both). librqbit fetches `blocklist_url` with the
session's client, which is bound to the tunnel or loopback: in a blocked
session that fetch fails and `Session::new_with_opts` errors. So stash
fetches URLs itself (the network probe's client: no proxy, 60 s timeout,
64 MiB cap) into `<state>/blocklist` when the cache is missing or older
than 24 h, and passes `file://<state>/blocklist` to librqbit. Fetch failure
→ use the cached copy; none → start without a blocklist and log a warning.
The panel shows "Blocklist: N ranges" (from a count stash makes while
caching). Copy says it is a filter, not protection.

### Settings in the UI (user: "improve the UI to make this ultra good")
Env vars set the starting values; the UI owns them afterwards.
- `<state>/settings.json` (`{ vpn: "strict"|"warn"|"off", blocklist:
  bool, blocklist_url?: string }`, written atomically, fsync + rename).
  Precedence: env var if set (shown as "set by STASH_VPN", control
  disabled), else settings.json, else default.
- `GET /api/settings` → values + where each came from + blocklist status
  (`ranges`, `updated_at`, `source`, `error`). `PUT /api/settings`
  validates, saves, and schedules a re-exec (2 s later, so the response
  gets out) because session options only apply at start. Guarded by the
  existing CSRF/Host middleware.
- New **Privacy** page (`/privacy`, rail + tab bar entry; the network
  chip links here instead of `/transfers#network`):
  1. "What peers see" (the existing network panel, moved here; Transfers
     keeps a one-line summary linking to it).
  2. Kill switch: three-option segmented control (Strict / Warn / Off)
     with one plain sentence per option and the current live state
     ("Torrents use utun6 only" / "No VPN: torrents are stopped").
  3. Blocklist: switch + "596,104 ranges · updated today · Naunter
     BT_BlockLists" + "Update now".
  4. Listen port (read-only for now; set by STASH_LISTEN_PORT) and a
     placeholder for the seeding rule (next roadmap item).
  Saving shows "Applying… stash restarts in a moment" and the UI waits for
  `/api/network` to answer again, then refreshes.
- Design: impeccable skill, Projection Booth system (DESIGN.md); Operate
  mode. Reviewed by typescript-expert as well as rust-expert.

### Listen port, UPnP, peer limit

- `STASH_LISTEN_PORT` (1–65535): `listen: Some(ListenerOptions { mode:
TcpAndUtp, listen_addr: [::]:port, announce_port: Some(port),
enable_upnp_port_forwarding: STASH_UPNP, .. })`. Unset: keep `listen:
None` (no incoming peers, as today). Port in use → startup error that
  names the variable.
- `STASH_UPNP` (`on`/`off`, default off). Ignored with a warning when
  `STASH_VPN != off` (UPnP opens a port on the home router, which defeats
  the VPN).
- `STASH_PEER_LIMIT` (default librqbit's).
- Strict parsing for all; bad values are startup errors.

## Not in this item
- Stop seeding when a download finishes: the user wants it first-class
  and on by default. It is the roadmap item `seeding-policy`, moved up to
  run right after this one (own branch/PR).

- NAT-PMP auto port forwarding (Proton changes the forwarded port on each
  reconnect; needs Proton Plus to test). New roadmap item
  `vpn-port-forwarding`.
- A UI toggle for the kill switch (needs persisted settings).

## Tests

- Unit: env parsing (`STASH_VPN`, `STASH_LISTEN_PORT`, `STASH_UPNP`,
  `STASH_PEER_LIMIT`), desired-binding decision table (tunnel default
  route → tunnel; non-tunnel → loopback; missing named iface → loopback),
  debounce state machine.
- Level table: strict/warn/off/<name> × tunnel/no tunnel → Bound/Blocked/Unbound.
- Blocklist: URL fetched to cache, stale cache refreshed, failed fetch
  keeps cache, oversize rejected, path passthrough, file:// URL built.
- Decision function table: dead index → stop now; route moved → stop now;
  non-tunnel → stop now; new tunnel stable 2 ticks after 30 s → restart;
  flapping inside 30 s → no restart; blocked → tunnel → restart.
- Session options builder: blocked has dht/trackers/LSD/listen off and
  binds loopback; bound has LSD off, DHT file in state dir.
- Stopped → writes rejected (503); exec failure → stays stopped, retries.
- New process whose desired binding equals its current one never schedules a restart.
- Blocklist file URL from a relative state dir.
- Re-exec is manual-tested (cannot exec inside cargo test); compare `lsof -p <pid> | wc -l` across 5 re-execs.
- Manual on this Mac with Proton: `STASH_VPN=auto`, connect/disconnect
  Proton, watch logs and the panel. Dual-stack scoping check (IPV6_BOUND_IF on a
  `[::]` socket for IPv4-mapped peers) needs `sudo tcpdump -i en0 -n` while
  bound to utun: ask the user to run it.

## Rollback

`STASH_VPN=off` restores the old behaviour; revert the PR.
