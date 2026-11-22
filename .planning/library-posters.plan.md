# library-posters

Roadmap: parse film/show names from file names; optional TMDB lookup (off
by default, user key) for posters, titles, seasons; a poster Library view
next to Files (user request 2026-11-21: "rich and beautiful, feature rich
and incredibly useful, fix all the gaps").

## What the user gets

- **Library** (new first nav item, the new home `/`): a poster grid.
  - Shelves at the top: **Continue watching** (later, from watch-state;
    hidden until it exists), **Recently added**, **Downloading** (with a
    progress ring on the poster).
  - Then **Films** and **Shows** grids, sort (Recently added, Title, Year),
    filter chips (Films / Shows / Downloading / Ready).
- **Title page** `/title/:key`: backdrop, poster, title, year, runtime,
  genres, overview, rating (all from TMDB when on), the files behind it
  with quality badges (2160p, 1080p, HDR, x265, audio language), and
  Play (best ready file), plus the existing per-file page for actions.
  - Shows: season tabs and the episode list (S01E03 · name · still image
    when TMDB is on; parsed number and file name otherwise), with
    ready/downloading state per episode and Play next.
- **Without TMDB** (default): still beautiful. Generated poster: a
  typographic card (title in Instrument Sans, year, colour field derived
  from the title hash in the Kiri palette range), and — when ffmpeg is
  available — a frame from the video as the backdrop/poster image
  (that is the thumbnails roadmap item; here only the typographic card).
- **Privacy page section "Posters & details"**: TMDB off/on, key field,
  explanation that titles (not files, not IP of peers) are sent to TMDB.
- **Fix match**: on the title page, "Wrong title?" → search TMDB, pick the
  right one; stored as an override. "Not a film" hides it from Library
  (still in Files).

## Server

- `src/library/parse.rs` (pure): file name → `Parsed { kind: Film|Episode|
Other, title, year, season, episode(s), quality: {resolution, hdr,
codec, source}, lang }`. Strip site prefixes (`www.x.com - `, `[group]`),
  dots/underscores, release tags. Episode patterns `S01E02`, `1x02`,
  `S01E01-E02`, `Season 1/Episode 2` from folders. Extras/samples
  (`sample`, `trailer`, `featurette`, < 60 MB) → Other. Table tests with
  ~60 real-world names.
- Grouping: a title key = normalised title + year (films) or title (shows).
  Library built on demand from the transfer list (no new store for the
  grouping itself).
- `src/library/tmdb.rs`: optional; key from `<state>/library.json` (set in
  UI) or `STASH_TMDB_KEY`. Search film/tv by title+year, details, season
  episodes. Cache JSON in `<state>/library-cache.json` (per title key, 30
  days) and images under `<state>/images/` (w342 posters, w780 backdrops,
  w300 stills), fetched once, served from `/api/library/images/{name}`
  with immutable cache headers. Rate limit: 1 in flight, ≤ 20 req/s.
  Network failures leave the typographic card; retried later.
  - Lookups go through the normal connection (not the torrent binding).
- API: `GET /api/library` → `{ titles: [{ key, kind, title, year, poster?,
backdrop?, overview?, genres?, rating?, added_at, files: [{tid, fid,
season?, episode?, quality, progress, ready}] }] }`.
  `GET /api/library/{key}`, `POST /api/library/{key}/match {tmdb_id,
kind}`, `POST /api/library/{key}/hide`, settings GET/PUT.
- CSP: images same-origin (served by us), no third-party image loads from
  the page.

## Web

- `views/Library.tsx`, `views/Title.tsx`, `components/Poster.tsx`
  (image with typographic fallback, progress ring, quality badge),
  `components/Shelf.tsx` (horizontal scroller, keyboard/remote roving).
- Nav: Library, Files, Transfers, Privacy. `/` → `/library`.
- Remote/TV: grid is a 2-D rove (arrow keys move by row/column).
- Motion: poster hover lift and focus ring; backdrop fades in; respects
  `prefers-reduced-motion`.
- Empty state: "Add a magnet to start your library" + paste hint.

## Tests

Rust: parser table, grouping, cache expiry, TMDB client against a fixture
server (no live calls in tests), image name validation (no traversal).
Web: Library grid/shelves/filters, Title page film and show, fallback
poster, fix match flow, 2-D keyboard nav.
Live: library of the current downloads (the 5MovieRulz-prefixed Telugu
film must parse to "Aadarsha Kutumbam House No 47 (2026)").

## Notes added before review

- TMDB terms: show "This product uses the TMDB API but is not endorsed or
  certified by TMDB" with their logo on the Privacy section and an
  attribution line in the Library footer. Images are cached locally (TMDB
  allows caching), never hotlinked (CSP stays same-origin).
- Key storage: `<state>/library.json` (0600), never returned by GET (only
  `key_set: true`), never logged. Lookups go through the normal connection
  with `no_proxy`; nothing torrent-related is sent, only the parsed title +
  year.
- Library is derived: grouping is recomputed from `/api/transfers` on each
  request (cheap), only TMDB results/overrides persist.
- Live updates: Library reuses the shared transfers poller for progress;
  `/api/library` is fetched on mount and when the set of transfers/files
  changes (keyed by ids), not every 1.5 s.
- Sizes: posters 2:3, grid `repeat(auto-fill, minmax(160px, 1fr))`, phone 3
  per row, TV (≥ 1600 px) 7 per row; focus ring scale 1.04.
- Out of scope here (own roadmap items): video-frame thumbnails
  (thumbnails), Continue watching (watch-state), media-info badges beyond
  what the file name says.

## Revisions after review (rust-expert + typescript-expert, both REQUEST_CHANGES)

Supersedes the sections above where they conflict. Scope is large, so the
item ships in two PRs on the same roadmap item: **PR A** (parser, Library
grid, title pages, typographic posters, navigation; no network) and **PR B**
(TMDB: settings, lookups, images, fix match). The roadmap box is ticked
after PR B.

### Server (PR A)
- `src/library/parse.rs`: per-file parse with folder components as context
  (season packs, collection packs, obfuscated names fall back to the folder).
  Rules from the review: strip site prefixes only when the first ` - `
  segment / bracket looks like a domain or known group; year = last
  plausible year (1900..=next year) before the first release tag; `NxNN`
  rejects a 3+ digit left side; anime `[Group] Title - 1085` absolute
  episodes, `v2` revisions, CRC tags; multi-episode lists; date episodes;
  `S00` specials; acronym dots (S.W.A.T., M.A.S.H); edition tags stripped;
  CD1/Part.1 merged; samples/extras only by token or folder (size alone
  never); `.srt` attaches to its sibling; ids `tt\d{7,8}` / `{tmdb-N}`
  captured for PR B. The 31 names from the review are the table test.
  Unicode: no new crate; keys compare case-folded ASCII-insensitive text,
  NFD/NFC gap documented.
- Keys: `film-<slug>-<year>` / `show-<slug>[-<year>]`, `[a-z0-9-]` only
  (non-Latin titles → `t-<fnv1a hex>`), never colliding with fixed routes.
  Kind and year in the key. FNV-1a (stable), not DefaultHasher.
- `first_seen` per info hash persisted in `<state>/library.json` (schema
  version, atomic write with a unique temp name, unreadable → set aside).
  Gives "Recently added". This is the one new store; overrides (hide now,
  match in PR B) live there too, keyed by info hash + file path, never by
  the derived key or librqbit's session id.
- API: `GET /api/library` → `{ titles: [{ key, kind, title, year,
  first_seen, files: [{ tid, fid, season?, episodes?, quality }],
  hidden }] , pending: [tid] }` — identity and metadata only; progress
  comes from the client's transfer poller. Transfers without metadata are
  listed in `pending`. `GET /api/library/{key}` adds per-episode detail.
  `POST /api/library/{key}/hide`, `DELETE /api/library/{key}/hide`.
  Deleted files excluded.

### Server (PR B)
- TMDB client: one `reqwest::Client`, URLs built with
  `Url::parse_with_params`; v4 token (`eyJ…`) as Bearer, v3 key as
  `api_key`; key validated on save (`/3/authentication`); `STASH_TMDB_KEY`
  → `source: "env"`; key file 0600 via `create_new + mode`; never in
  responses, logs or errors (`without_url`).
- Routing: lookups and images follow `download_route()` like the blocklist
  (through the VPN when bound, skipped while blocked). Privacy copy says
  TMDB sees titles and the IP address of that route.
- Background worker: one in flight, dedup, never in the request path;
  `pending` flag per title; hits 30 d, misses 7 d, errors backoff, 429 +
  Retry-After. Match: id → year → year±1 → no year, accept only close
  normalised title matches; `language=en-US`, keep `original_title`.
- Images: TMDB paths must match `^/[A-Za-z0-9_-]{1,64}\.(jpg|png)$`; local
  name `{w342|w780|w300}_{stem}.{ext}`; route validates the same pattern
  before join (404 otherwise); upstream content type + magic bytes; ≤ 5 MB
  each, 500 MB total with orphan cleanup; stills only for the viewed
  season; `immutable` on 200 only. `GET /api/library/search`, match set /
  clear routes. TMDB attribution + logo (bundled).

### Web (PR A)
- Library is the index route (`/`), nav: Library, Files, Transfers,
  Privacy. Wordmark, `*`, Watch Esc, add-and-go and delete flows updated
  to return to where the user came from (`{ from: "title", key }` state;
  last focused poster restored on Back).
- `lib/library.ts`: `parseLibrary(unknown)` guards (discriminated union
  film | show), `createLibraryStore(deps)` with `useSyncExternalStore`;
  refetch when a signature of `id:files.length:deleted` changes and after
  every mutation. Status joined client-side via `fileStatus()`.
- Play: best quality among ready files, else the most complete streaming
  file ("Play while downloading"); version menu when several qualities.
  Shows: "Play S01E01" (first playable), "next" waits for watch-state.
- Filters: two segmented groups in URL params (`type=films|shows`,
  `state=downloading|ready`); shelves hidden while filtering/searching.
  Search box filters Library in place on `/` (label follows the route),
  with "Also N matching files →" to Files.
- Season picker: pressed-button group (`.tabs`, `aria-pressed`), `<select>`
  over 8 seasons. Hidden titles: "Hidden (n)" footer link → unhide.
- `data-rove="grid"` in keys.ts: Left/Right by position, falling through
  to `moveZone` at the edge; Up/Down nearest x-centre in the row above /
  below, crossing into the previous/next list in the zone (as Up/Down
  already do after PR #4). Pure `nextInGrid(rects, from, dir)` unit-tested.
  Per-shelf last focus remembered. Focused poster `scrollIntoView` nearest.
- Posters: `memo` with primitive props; typographic card always rendered
  (title balanced, clamped, sized by length; year + quality in mono; colour
  field from the existing `swatch()` hash so a title has one hue in Files,
  Library and the player room); image fades in over it (PR B), card stays
  on error. Ring + "Playable now" pill while downloading. Fetching-details
  card for `pending` transfers on the Downloading shelf.
- Title page lights the room with the title's colour (`room.setScreen`).
- Grid: `repeat(var(--cols), 1fr)` with container-query column counts
  (3 phone / 4 / 5 / 7 TV); no virtualisation; `content-visibility: auto`
  + `contain-intrinsic-size`; images lazy with width/height.
- A11y: each poster one `<a>` named "Title, year, film, downloading 43%";
  ring/badges `aria-hidden`; `section aria-labelledby` + `ul/li`; no
  progress in live regions; focus outline independent of scale.
- Empty states: no titles but files exist → "Your N files aren't films or
  shows. See Files."; nothing at all → add hint; server unreachable → the
  existing banner.

### Tests
Rust: parser table (31+ names), keys, first_seen persistence, hide/unhide,
grouping per file with packs. Web: `nextInGrid` table, Back restores the
poster, delete last file lands on next poster, signature refetch with fake
timers, posters don't re-render on an unchanged poll, search in place,
`parseLibrary` rejects bad shapes, pending card, filters.
