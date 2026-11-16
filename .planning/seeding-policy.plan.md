# seeding-policy

Roadmap: stop seeding as soon as a download finishes, on by default
(first-class rule, user request 2026-11-15). Optional ratio or time limit
instead.

Facts checked (librqbit 9.1, live on macOS):

- `stats.finished` is true once every selected file is complete.
- A paused, finished torrent still streams (`GET …/files/1` with a Range
  header → 206). Stopping seeding never breaks playback.
- `stats.uploaded_bytes` counts only while the torrent is live, per
  session: it resets to 0 on pause, restart and stash re-exec. A ratio
  limit needs stash's own cumulative counter.
- `Api::api_torrent_action_pause` goes through `Session::pause`, which
  persists the paused flag (survives restarts).

## Policy

`SeedingPolicy` (one per stash, not per transfer):

- `stop` (**default**): pause as soon as `finished`.
- `ratio(r)`: pause when uploaded ≥ r × total_bytes (r in 0.1–100).
- `time(d)`: pause d after the torrent was first seen finished
  (d 1 minute – 365 days).
- `forever`: never pause (today's behaviour).

Sources, same precedence as the Privacy settings: env `STASH_SEEDING`
(`stop` | `forever` | `ratio:1.5` | `time:24h` / `90m` / `7d`), then
`settings.json` (`"seeding": {"mode": …, "ratio"?, "minutes"?}`), then
default `stop`. Strict parsing; bad env value is a startup error.

## Manual override

"Resume seeding" on a finished transfer is an explicit choice: the policy
must not pause it again 5 s later. `POST /api/transfers/{id}/start` on a
finished transfer adds its info-hash to `keep_seeding`; pausing it (by the
user) or deleting it removes the entry. The policy skips entries in
`keep_seeding`. Starting an unfinished transfer adds nothing (the policy
applies when it finishes).

## State: `<state>/seeding.json`

```json
{ "keep_seeding": ["<info_hash>", …],
  "torrents": { "<info_hash>": { "finished_at": 1794809015,
                                 "uploaded_base": 123456,
                                 "last_live_uploaded": 789 } } }
```

- `finished_at`: first time stash saw `finished` (for `time`).
- Cumulative uploaded = `uploaded_base + live counter`. When the live
  counter drops below `last_live_uploaded` (pause/restart reset),
  `uploaded_base += last_live_uploaded` first.
- Written atomically (tmp + fsync + rename), only when something changed,
  at most every 30 s plus on a pause decision. Entries for torrents no
  longer in the session are dropped. Unreadable file → start empty, warn.

## Enforcer (`src/seeding.rs`)

Tokio task, tick every 5 s:

1. `api.api_torrent_list_ext(with_stats)`.
2. For each torrent with stats: update the counters; if `finished`, state
   `live`, not in `keep_seeding`, and the policy says done → pause through
   `api.api_torrent_action_pause` (persists) and log
   `info!(name, reason, "stopped seeding")`.
3. Skip entirely while the kill switch has stopped the session (privacy
   `stopped`/blocked), and take the privacy write guard for the pause so it
   never races a restart.
4. A failed pause is logged and retried next tick.

The policy lives in an `RwLock` so changing it from the UI applies at once
(no restart).

## API

- `GET /api/settings` adds `seeding: { mode, ratio, minutes, from }`.
- `PUT /api/settings` accepts `seeding`; a seeding-only change is saved
  and applied live, response `200 {"restart": false}`; changes that touch
  vpn/blocklist keep `202 {"restart": true}`. Env-set → 409.
- `/api/transfers` items gain `seeding: { keep: bool, uploaded: u64,
finished_at: u64|null, stopped_by_policy: bool }` for the UI.

## Web

- Privacy page → its Connections "Seeding" row becomes a **Seeding**
  section: radio cards Stop when finished (Recommended) / Until ratio
  [number] / For [hours] / Keep seeding. Save applies instantly when only
  seeding changed (no restart wait).
- Transfers: a finished transfer stopped by the policy reads
  "Done · not seeding" (instead of "Done · paused"), button "Seed" with
  `title` "Seed this one anyway (the seeding rule skips it)". A kept one
  reads "Done · seeding (kept)". Uploaded total shown in meta when > 0.
- Copy states the trade-off once: seeding helps others finish downloads
  and exposes your IP for longer.

## Tests

Rust: policy parsing (env forms, bounds), decision table (mode ×
finished × keep × uploaded × elapsed), counter reset accounting,
override add/remove via start/pause/delete, persistence round-trip and
unreadable file, enforcer skips while stopped (pure function over a
snapshot so it is testable without a session).
Web: settings parse with seeding, Seeding section (env lock, instant save
path without restart wait), transfer labels for not-seeding / kept.

## Rollback

`STASH_SEEDING=forever` restores today's behaviour; revert the PR.


## Revisions after review (rust-expert + typescript-expert, both REQUEST_CHANGES)

Server
- One `tokio::sync::Mutex<SeedState>`; lock order everywhere: privacy
  write gate, then seeding lock. The enforcer snapshots without locks,
  then for a candidate takes the write guard (Unavailable → skip tick
  quietly), the seeding lock, re-reads that torrent's stats by info-hash,
  re-checks keep/policy, then pauses by hash. "Already paused" = success.
- Upload accounting per hash: `uploaded_base_bytes`,
  `last_live_uploaded_bytes`, `last_boot`. Fold (base += last, last = 0)
  when `last_boot != boot_id`, when the torrent isn't live, and when the
  live counter drops; fold from a fresh stats read before any pause
  (user or policy). saturating_add. Flushed every 10 s when dirty, before
  any pause, and from a pre-exec hook (try_lock) on restart.
- `keep_seeding` is added on a user start only when the policy says the
  torrent is done at that moment (no ratio/time bypass; nothing under
  `forever`). User pause and delete remove it.
- `stopped_by_rule` persisted: set when the enforcer pauses, cleared on any
  user start/pause.
- Settings file: `seeding` read as a raw JSON value and validated after
  load; invalid → warn and default, vpn/blocklist untouched.
- Delete resolves id → info-hash before deleting; entries are only ever
  removed by delete (no pruning).
- Early pause: a torrent still `Initializing` (not paused) whose hash has a
  `finished_at`, not kept, and the policy says done → pause right away
  (closes the post-restart seeding window). Tick 2 s.
- Enforcer JoinHandle watched like the kill-switch supervisor (exit 70).
- Unreadable seeding.json → renamed to `seeding.json.bad-<ts>`, start empty.
- Ratio uses selected bytes (`total_bytes`); total 0 → done. Time is
  wall-clock since stash first saw it finished (saturating_sub); for
  torrents already finished at upgrade it counts from the upgrade.
- Env `STASH_SEEDING`: trim + lowercase; `stop|forever|ratio:R|time:Nm|Nh|Nd`
  (integers for time; ratio finite 0.1–100; time 1 min–365 d).
- API: `/api/transfers` items wrap librqbit's details with
  `seeding: {keep, uploaded_bytes, finished_at, stopped_by_rule, stops_at,
  target_bytes}` (keep reported as effective: false under forever).
  `PUT /api/settings` accepts `seeding`; seeding-only → `200
  {"restart":false}` and applied live; mixed → applied live too, `202
  {"restart":true}`; works while a restart is pending; env-locked → 409.
  Live policy in `std::sync::RwLock<(SeedingPolicy, From_)>`.
- CHANGELOG/README: existing finished torrents stop seeding after upgrade.

Web
- `saveSettings` returns `{restart: boolean}` from the status (202/200);
  seeding-only save → reload, "Saved. Finished transfers stop seeding
  within a few seconds." (no restart wait). Mixed: settle + verify seeding
  too; reset the seeding draft from the server after settle; `changed`
  includes seeding. Env-locked seeding never sent.
- Button "Save" vs "Save and restart" by which fields are dirty.
- Number fields outside the radio labels, own visible labels, `type=text
  inputMode=decimal`, comma accepted, validated against server bounds,
  `aria-invalid` + error text, Save refused (Enter too). Draft kept as
  text, compared after normalising (hours → minutes). Hours UI (≤2
  decimals, ≥ 0.1 h); a locked env value that doesn't fit shows as text.
- Discriminated `SeedingPolicy` union; `parseSettings` requires it;
  `parseTransfer` keeps the transfer and sets `seeding: null` if malformed.
- Transfers: one name "Seed" for every paused finished transfer; meta says
  "Done · not seeding (seeding rule)" / "Done · paused" / "Done · seeding
  (kept)" / "Done · seeding, stops in 3 h" / "Done · seeding until 1.5×";
  uploaded shown. Writes-paused reason wins the title.
- Copy: "Stop sharing once a download finishes" (peers still get pieces
  while it downloads); trade-off: "keeps your address visible to peers
  for longer".
- Tests per the web review list.
