# Changelog

## Unreleased

### Changed
- **Seeding stops when a download finishes, by default (`STASH_SEEDING=stop`).** Finished transfers that were seeding stop a few seconds after upgrading. Pick "Keep seeding" on the Privacy page or set `STASH_SEEDING=forever` for the old behaviour.
- **Kill switch on by default (`STASH_VPN=strict`).** Torrent traffic only uses a VPN tunnel; without one, stash runs with no P2P networking. If you torrent without a VPN, set `STASH_VPN=warn` or `off`, or choose Warn/Off on the Privacy page.
- Local peer discovery is off whenever the kill switch is on.

### Added
- Delete one file of a transfer from the Files list or the file page (`DELETE /api/transfers/{id}/files/{n}`). The next start rechecks that transfer once.
- `librqbit` is pinned to `=9.1.0` (file delete relies on its startup behaviour).
- Seeding rule: stop when finished, until a ratio, for a time, or forever; "Seed" keeps one transfer seeding; upload totals that survive restarts.
- Privacy page: traffic path, kill switch levels (strict / warn / off), peer IP blocklist (daily list, on by default), listen port status.
- `STASH_VPN`, `STASH_BLOCKLIST`, `STASH_LISTEN_PORT`, `STASH_UPNP`, `STASH_PEER_LIMIT`.
- `GET/PUT /api/settings`, `POST /api/settings/restart`, `POST /api/blocklist/refresh`; `/api/network` reports `kill_switch`.
- Network status chip and panel (`GET /api/network`).
