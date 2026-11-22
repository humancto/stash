# file-delete

Roadmap: delete a single downloaded file (not the whole transfer) from the
Files list and the file page: deselect it in the torrent so it is not
downloaded again, remove it from disk, confirm first (user request
2026-11-16).

## Facts checked (librqbit 9.1 source)

- `Api::api_torrent_action_update_only_files(id, &HashSet<usize>)` works
  for Live and Paused torrents, bails while Initializing, and persists
  `only_files` (session persistence). Files outside the set report
  `included: false` in details.
- `FilesystemStorage::init` opens **every** non-padding file with
  `create(true)` (stash adds with `overwrite: true`) on each torrent init
  (startup, re-exec). A deleted file therefore comes back as a 0-byte file
  at the next start. `ensure_file_length` only runs for selected files, so
  it stays 0 bytes.
- Files stay open across pause/unpause (`files.take()`). Unlinking alone
  does not free disk space until stash restarts or the torrent is deleted.
  Truncating through our own handle first (`set_len(0)`) frees it at once
  (same inode).
- The `have` bitfield is not touched by `update_only_files`. Until the next
  start, stash still advertises the deleted file's pieces; a peer that
  requests one gets a read error and that peer connection drops. At the
  next start, fastresume validation samples one claimed piece per file,
  the sample from the deleted file fails, and librqbit does a full recheck
  (once; the new bitfield is stored).
- Boundary pieces: a piece shared between the deleted file and a kept file
  is lost by the recheck. The kept file then reads as incomplete (one
  piece) and the piece is selected again because the kept file needs it.
  Re-downloading it writes the deleted file's share of that piece, so the
  deleted path can come back as a mostly-sparse file.

## API

`DELETE /api/transfers/{id}/files/{file_id}` (same CSRF/Host guard as other
writes).

1. `privacy.write_guard()` (Unavailable → 503 like other writes), then the
   seeding lock (lock order unchanged: gate, then seeding). Selected bytes
   change, so ratio targets must not be computed mid-change.
2. Resolve the handle; metadata must be resolved; `file_id` in range;
   not a padding file; currently included. Already excluded → 200 with
   `freed_bytes: 0` (idempotent; still runs the disk cleanup).
3. Initializing → 409 "still checking files, try again in a moment".
4. Last included non-padding file → 409 "this is the last file; delete
   the transfer instead". The UI never offers it in that case.
5. `update_only_files(current included set − file_id)` (padding entries
   are kept as they are).
6. Disk: path = torrent output folder + `relative_filename`. Canonicalize
   the parent and require it under the canonical `STASH_DIR`;
   `symlink_metadata` must be a regular file (symlink or dir → skip, warn).
   Open write-only without create, `set_len(0)`, drop, `remove_file`.
   `NotFound` at any step → fine. Then remove empty parent directories up
   to (not including) the torrent's root folder, and `STASH_DIR` itself is
   never removed.
7. Record the deletion in `<state>/seeding.json` → rename to keep one state
   file? No: a new `deleted` map inside the same `SeedState`
   (`hash → [file_id]`), saved atomically with the rest. Used by the
   cleanup and repair below.
8. Response `200 {"freed_bytes": n}` (length on disk before truncation).

Disk I/O runs in `spawn_blocking`.

## Placeholder cleanup and boundary repair (enforcer pass)

Once per torrent per boot, after it has left Initializing:

- For each recorded deleted file of that torrent that exists on disk with
  length 0 and is a regular file under `STASH_DIR`: remove it (0 bytes →
  nothing lost).
- Repair: if the torrent has recorded deletions, is paused, is **not**
  finished, and stash had recorded `finished_at` for it (it was finished
  before), the missing pieces are boundary pieces lost by the recheck.
  Start it (only when `privacy.can_add()`), so the kept files complete;
  the seeding rule pauses it again once finished. Logged once.
- Sparse leftovers (non-zero length) after a boundary re-download are
  truncated + removed by the same rule once the torrent is finished again
  (the deleted file is excluded, so nothing reads it).

## Stream endpoint

`GET /api/transfers/{id}/stream/{file_id}` for an excluded file → 410
Gone ("this file was deleted"). Prevents serving a 0-byte/sparse file.

## Web

- `api.removeFile(tid, fid): Promise<{freedBytes}>`.
- `flatten` (Files list) and the Transfers file list skip files with
  `included: false`; the Transfers "N files" count excludes them.
- `ConfirmDelete` gains an optional `prompt` prop (default keeps today's
  "Delete X and its files from disk?").
- File page (Watch) rail: "Delete file" (prompt: `Delete “name” from
disk? stash won't download it again.`), then navigate to `/files` with
  replace. Shown only when the transfer has more than one included file;
  otherwise only "Delete transfer" is shown (as today).
- Files list: each row gets a small trailing delete button outside the
  `<Link>` (not nested in it), same two-step inline confirm, focus returns
  to the next row (or the list) after delete. Hidden for single-file
  transfers' only file? No: on the Files list a single-file transfer's
  file shows "Delete" that deletes the transfer (prompt says so), so every
  row can be deleted from the list.
- Writes paused (kill switch) → disabled with the reason, like the others.
- Watch page for an excluded file (old link) → "This file was deleted."
  with a link back to Files, no player.

## Tests

Rust:

- Path guard: `..`/absolute components, symlink target, dir → refused.
- Truncate + remove: space freed while another handle is open (unix),
  NotFound is OK, empty parent dirs removed up to the root only.
- Selection: last-file refusal, padding kept, already-excluded idempotent.
- `deleted` map persistence round-trip; old `seeding.json` without it
  loads.
- Cleanup decision (pure): 0-byte → remove, non-zero while unfinished →
  keep, repair condition table.
- Stream of excluded file → 410.
- Live check on the real box with a multi-file torrent: delete one file
  → space freed, file gone, others still stream; restart → placeholder
  removed, kept files complete again.

Web: flatten hides excluded files; Watch shows Delete file only with >1
included file; Files row delete for single-file transfer calls `remove`,
otherwise `removeFile`; prompt text; paused reason; deleted-file page.

## Rollback

Revert the PR. Files already deleted stay deleted and deselected
(librqbit persistence); nothing else changes. The `deleted` map is ignored
by older builds (serde default / unknown field).

## Revisions after review (rust-expert + typescript-expert, both REQUEST_CHANGES; user chose option A)

Superseded above: the "placeholder cleanup and boundary repair" section,
step order, the stream path, parent-dir removal.

Server
- Route: `/api/transfers/{id}/files/{file_id}` = `get(stream).delete(remove_file)`.
  `stream` returns 410 for an excluded file **before** `api_stream` (live
  streams fetch unselected pieces, which would re-download it).
- New `src/filedelete.rs` (pure, unit-tested): path guard, disk removal,
  `shares_selected_piece`, placeholder check.
- Order: validate → persist intent (`deleted[hash][fid] = pending`,
  `recheck_pending[hash] = boot`) → `update_only_files` → disk → mark
  `done`. Seeding lock held only for "read only_files, persist intent,
  update_only_files"; disk work under the write guard only. A pending intent
  left by a crash/re-exec is finished by the enforcer.
- Disk: rel path must be only Normal components; canonical parent must be
  under canonical `output_folder()`; open `O_WRONLY|O_NOFOLLOW` (no create),
  `fstat` regular file, length ≤ torrent length (else refuse: not ours);
  `nlink == 1` → `set_len(0)` then unlink, `freed = blocks × 512`;
  `nlink > 1` → unlink only, freed 0. NotFound anywhere = already gone. No
  parent-dir removal (librqbit recreates dirs on init).
- Last-file rule counts included, non-padding, non-hidden files (same as the
  UI's `sole`). Initializing → 409.
- `decide`: while `starting` and `recheck_pending`, Leave (don't abort the
  recheck). `recheck_pending[hash]` clears once seen non-initializing in a
  boot other than the recorded one.
- Placeholder rule (each boot, once per torrent, after init): a done
  deletion whose file shares **no** piece with an included non-padding file,
  still excluded, regular, 0 bytes, nlink 1 → removed. Files that share a
  piece are never touched after the delete (touching them causes a recheck
  every boot); the UI copy says a small leftover may remain.
- Repair: torrent with deletions, Paused, not finished, `stopped_by_rule`,
  no recheck pending this boot, `can_add()` → start it under the write
  guard (retried each pass); the rule pauses it again when finished.
- `user_delete` clears `deleted[hash]` and `recheck_pending[hash]`.
  Cleanup also requires the file to still be excluded.
- `TransferItem` gains `deleted: [file_id]` so the UI tells "deleted" from
  "skipped". `librqbit` pinned to `=9.1.0` (behaviour depends on its init /
  fastresume internals).

Web
- `api.removeFile(tid, fid): Promise<void>` (DELETE, same path as stream).
  `Transfer.deleted: number[]` (lenient, default []).
- `flatten` skips excluded files; `FileEntry.sole` = no other visible
  (non-padding, non-hidden) included file, from the full file list.
  Transfers list/count skip excluded files.
- `keys.ts moveInList`: position from the enclosing `li`'s rove item, so
  Up/Down from a row's delete button or confirm moves to the next row. The
  delete button is not a rove item (Tab reaches it).
- Files: `useWritesPaused()` once; `FileRow` gets `pausedReason`; `sameRow`
  compares `f` (incl. `sole`) and `pausedReason`. `pendingFocus` ref + 
  `data-key` on the Link; after delete focus the next row in `shown`
  (previous if last; empty state otherwise); polite live region
  "Deleted “name”". Confirm renders full-width under the row with a short
  prompt. Sole file → deletes the transfer ("Delete the whole transfer
  “X” from disk?").
- `ConfirmDelete`: `prompt`, `ariaLabel` props; error has `role="alert"`;
  resets busy/asking after success if still mounted.
- Watch: `useWritesPaused()` for both deletes; "Delete file" when not sole;
  deleted state (excluded) renders no player/download/copy/VLC, says "This
  file was deleted." + back to Files. After delete: navigate first, then
  refresh.
- Tests per both reviews' lists (keys, focus, sameRow, flatten sole,
  ConfirmDelete, Watch deleted state, removeFile contract).

Rust tests: path guard, hardlink (nlink>1 untouched content), symlink
refused, size-mismatch refused, NotFound ok, shares_selected_piece table
(head/tail/small-between/padding/neighbour deleted), decide with
recheck_pending, repair condition, state round-trip + old file, user_delete
clears. Live check on a real multi-file torrent incl. two restarts (second
must not recheck).
