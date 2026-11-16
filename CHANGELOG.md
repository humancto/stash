# Changelog

## Unreleased

### Changed
- **Kill switch on by default (`STASH_VPN=strict`).** Torrent traffic only uses a VPN tunnel; without one, stash runs with no P2P networking. If you torrent without a VPN, set `STASH_VPN=warn` or `off`, or choose Warn/Off on the Privacy page.
- Local peer discovery is off whenever the kill switch is on.

### Added
- Privacy page: traffic path, kill switch levels (strict / warn / off), peer IP blocklist (daily list, on by default), listen port status.
- `STASH_VPN`, `STASH_BLOCKLIST`, `STASH_LISTEN_PORT`, `STASH_UPNP`, `STASH_PEER_LIMIT`.
- `GET/PUT /api/settings`, `POST /api/settings/restart`, `POST /api/blocklist/refresh`; `/api/network` reports `kill_switch`.
- Network status chip and panel (`GET /api/network`).
