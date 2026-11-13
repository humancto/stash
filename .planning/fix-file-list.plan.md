# fix-file-list (final, after rust-expert review round 1)

Roadmap item: `/api/transfers` includes each transfer's files so the UI shows Play/Download; handle suffix ranges (`bytes=-N`).

## Problem

- `Api::api_torrent_list_ext` builds each `TorrentDetailsResponse` with `files: None` ("filled in /details"). The UI renders file rows from `t.files`, so no Play/Download link ever appears.
- The stream endpoint's range parser treats `bytes=-500` as unparseable and returns `200` with the whole file instead of `206` with the last 500 bytes.

## Change (src/main.rs only)

1. `list`: after `api_torrent_list_ext(with_stats: true)` **returns**, for each torrent with `id: Some(id)`, call `api.api_torrent_details(TorrentIdOrHash::Id(id))` and move its `files` into the entry. Never call it inside a `with_torrents` closure (re-entrant `db.read()` can deadlock under parking_lot when a writer waits); comment says so.
   - No metadata yet: details returns `files: Some(vec![])`, which the UI already handles.
   - Only error: torrent deleted between the two calls (404). Log at `debug`, keep the entry with `files: None`.
   - Cost: O(total files) string allocations per poll. Acceptable until live-events replaces polling.
2. Pure range parser, parse first, then decide satisfiability:

   ```rust
   #[derive(Debug, PartialEq, Eq)]
   enum RangeReq { Full, /// `end` is exclusive
                   Partial { start: u64, end: u64 }, Unsatisfiable }
   fn parse_range(header: Option<&str>, len: u64) -> RangeReq
   ```

   Syntax (anything else → `Full`):
   - `split_once('=')`, unit matched with `eq_ignore_ascii_case("bytes")`.
   - No `,` (single range only); exactly one `-`.
   - Each number non-empty and all ASCII digits (rejects `+`, whitespace). A digit-only number that overflows u64 saturates to `u64::MAX`.
   - Forms: `first-`, `first-last` (with `last >= first`, else `Full`), `-suffix`. `-` alone → `Full`.

   Satisfiability (after syntax):
   - `first-…`: `first >= len` → `Unsatisfiable`; else `[first, min(last.saturating_add(1), len))`.
   - `-suffix`: `suffix == 0` or `len == 0` → `Unsatisfiable`; else `[len - min(suffix, len), len)`.

3. Pure `content_range(start, end_excl, len) -> String` producing `bytes {start}-{end_excl-1}/{len}`; tested.
4. Behaviour change (correct per RFC 9110): inverted `bytes=10-5` now yields `200` instead of `416`.

## Tests

Table tests for `parse_range`: none, open-ended, closed, `0-0`, `end == len-1`, end past len clamped, `end = u64::MAX`, overflowing last-byte-pos clamped, overflowing first-byte-pos → Unsatisfiable, suffix, suffix == len, suffix > len, suffix 0, `bytes=-`, `bytes=5`, `+` signs, `BYTES=`/`Bytes=`, whitespace, multi-range, wrong unit, garbage, start == len, inverted, malformed header on len 0 → Full, valid range on len 0 → Unsatisfiable. Tests for `content_range`.

Gates: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. Live check recorded in the PR: list shows files; `curl -r -500` on the Big Buck Bunny mp4 → 206 `bytes 276134447-276134946/276134947`.

## Out of scope

Security headers / MIME restrictions (security-hardening), UI redesign (web-ui).

## Rollback

Single squash commit; `git revert`.
