// The Library: films and shows the server recognised in transfer file
// names. The server sends identity and metadata only; status and progress
// come from the shared transfers poll, joined here, so there is one source
// of truth for "how far along is it".

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, api, type Transfer } from "./api";
import { fileStatus, type FileStatus } from "./files";
import { useTransfers } from "./store";

export interface Quality {
  resolution: string | null;
  hdr: boolean;
  codec: string | null;
  source: string | null;
  languages: string[];
}

export interface TitleFile {
  tid: number;
  fid: number;
  name: string;
  size: number;
  season: number | null;
  episodes: number[];
  date: string | null;
  quality: Quality;
}

interface TitleBase {
  /** `film-…` / `show-…`, `[a-z0-9-]` only. */
  key: string;
  title: string;
  year: number | null;
  /** Unix seconds stash first saw the newest of its transfers. */
  added: number;
  hidden: boolean;
  files: TitleFile[];
}
export type Title =
  (TitleBase & { kind: "film" }) | (TitleBase & { kind: "show" });

export interface Library {
  titles: Title[];
  /** Transfers still fetching their file list. */
  pending: number[];
  /** Video files that aren't films or episodes (extras, samples). */
  otherFiles: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
const optStr = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const KEY = /^(film|show)-[a-z0-9-]{1,190}$/;

function parseQuality(v: unknown): Quality {
  const q = isObj(v) ? v : {};
  return {
    resolution: optStr(q["resolution"]),
    hdr: q["hdr"] === true,
    codec: optStr(q["codec"]),
    source: optStr(q["source"]),
    languages: Array.isArray(q["languages"])
      ? q["languages"].filter((l): l is string => typeof l === "string")
      : [],
  };
}

function parseFile(v: unknown): TitleFile | null {
  if (!isObj(v)) return null;
  const tid = int(v["tid"]);
  const fid = int(v["fid"]);
  const size = int(v["size"]);
  const name = optStr(v["name"]);
  if (tid === null || fid === null || size === null || name === null)
    return null;
  const episodes = Array.isArray(v["episodes"])
    ? v["episodes"].map(int).filter((n): n is number => n !== null)
    : [];
  return {
    tid,
    fid,
    name,
    size,
    season: int(v["season"]),
    episodes,
    date: optStr(v["date"]),
    quality: parseQuality(v["quality"]),
  };
}

function parseTitle(v: unknown): Title | null {
  if (!isObj(v)) return null;
  const key = optStr(v["key"]);
  const title = optStr(v["title"]);
  const kind = v["kind"];
  if (!key || !KEY.test(key) || title === null) return null;
  if (kind !== "film" && kind !== "show") return null;
  const files = Array.isArray(v["files"])
    ? v["files"].map(parseFile).filter((f): f is TitleFile => f !== null)
    : [];
  if (files.length === 0) return null;
  const base: TitleBase = {
    key,
    title,
    year: int(v["year"]),
    added: int(v["added"]) ?? 0,
    hidden: v["hidden"] === true,
    files,
  };
  return kind === "film" ? { ...base, kind } : { ...base, kind };
}

/** Checks the server's answer; bad titles are dropped, a bad shape throws. */
export function parseLibrary(v: unknown): Library {
  if (!isObj(v) || !Array.isArray(v["titles"]))
    throw new ApiError("The server sent an unexpected library.", 0);
  return {
    titles: v["titles"].map(parseTitle).filter((t): t is Title => t !== null),
    pending: Array.isArray(v["pending"])
      ? v["pending"].map(int).filter((n): n is number => n !== null)
      : [],
    otherFiles: int(v["other_files"]) ?? 0,
  };
}

// ---- store ------------------------------------------------------------

export interface LibrarySnapshot {
  library: Library | null;
  loading: boolean;
  error: string | null;
}

export interface LibraryDeps {
  fetchLibrary: () => Promise<Library>;
}

/** Fetches when the set of transfers/files changes (`sync`) or after a
 * library change (`refresh`), not on every transfers poll. */
export function createLibraryStore(deps: LibraryDeps) {
  let snapshot: LibrarySnapshot = { library: null, loading: true, error: null };
  let signature: string | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = (next: LibrarySnapshot) => {
    snapshot = next;
    for (const l of listeners) l();
  };
  async function load(): Promise<void> {
    const id = ++seq;
    try {
      const library = await deps.fetchLibrary();
      if (id === seq) emit({ library, loading: false, error: null });
    } catch (e) {
      if (id === seq)
        emit({
          ...snapshot,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sync(next: string) {
      if (next === signature) return;
      signature = next;
      void load();
    },
    refresh: () => load(),
  };
}

export type LibraryStore = ReturnType<typeof createLibraryStore>;

export const library = createLibraryStore({
  fetchLibrary: async () => parseLibrary(await api.library()),
});

/** What the Library depends on: transfers, their file lists, deletions. */
export function librarySignature(list: Transfer[]): string {
  return list
    .map(
      (t) =>
        `${t.id}:${t.files?.length ?? -1}:${t.deleted.join(",")}:${
          t.files?.filter((f) => !f.included).length ?? 0
        }`,
    )
    .sort()
    .join("|");
}

/** The library, kept in step with the transfers poll. */
export function useLibrary(store: LibraryStore = library) {
  const { transfers, loading } = useTransfers();
  const sig = loading ? null : librarySignature(transfers);
  useEffect(() => {
    if (sig !== null) store.sync(sig);
  }, [sig, store]);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const byId = useMemo(() => indexTransfers(transfers), [transfers]);
  return { ...snap, byId };
}

// ---- joining with transfers ------------------------------------------

/** Transfers by id, built once per poll snapshot. */
export type TransferIndex = ReadonlyMap<number, Transfer>;
export const indexTransfers = (list: readonly Transfer[]): TransferIndex =>
  new Map(list.map((t) => [t.id, t]));

export function statusOf(byId: TransferIndex, f: TitleFile): FileStatus {
  const t = byId.get(f.tid);
  const file = t?.files?.[f.fid];
  if (!t || !file) return { kind: "checking" };
  return fileStatus(t, f.fid, file);
}

export type TitleState =
  | { kind: "ready" }
  /** Something is downloading; `someReady` when other files can play. */
  | { kind: "streaming"; pct: number; someReady: boolean }
  | { kind: "paused"; pct: number }
  | { kind: "checking" }
  | { kind: "error"; message: string };

/** One state for a title. An active download wins (a show with season 1 on
 * disk and season 2 arriving is "downloading"); then ready if any file is;
 * then paused, error, checking. */
export function titleState(byId: TransferIndex, t: Title): TitleState {
  const all = t.files.map((f) => statusOf(byId, f));
  const ready = all.some((s) => s.kind === "ready");
  const pct = (k: "streaming" | "paused") =>
    Math.max(...all.map((s) => (s.kind === k ? s.pct : -1)));
  if (all.some((s) => s.kind === "streaming"))
    return { kind: "streaming", pct: pct("streaming"), someReady: ready };
  if (ready) return { kind: "ready" };
  if (all.some((s) => s.kind === "paused"))
    return { kind: "paused", pct: pct("paused") };
  const err = all.find((s) => s.kind === "error");
  if (err && err.kind === "error")
    return { kind: "error", message: err.message };
  return { kind: "checking" };
}

export const canPlaySome = (s: TitleState) =>
  s.kind === "ready" || (s.kind === "streaming" && s.someReady);
export const isDownloading = (s: TitleState) =>
  s.kind === "streaming" || s.kind === "paused";

const RES_RANK: Record<string, number> = {
  "2160p": 6,
  "1440p": 5,
  "1080p": 4,
  "720p": 3,
  "576p": 2,
  "480p": 1,
  "360p": 0,
};
const rank = (f: TitleFile) => RES_RANK[f.quality.resolution ?? ""] ?? -1;

export interface PlayChoice {
  file: TitleFile;
  /** Still downloading: plays what has arrived. */
  streaming: boolean;
}

/** What Play starts: the best-quality ready file, else the most complete
 * downloading one (stash streams while downloading). For shows, the first
 * episode in order that can play. */
export function playChoice(byId: TransferIndex, t: Title): PlayChoice | null {
  const withStatus = t.files.map((f) => ({ f, s: statusOf(byId, f) }));
  if (t.kind === "show") {
    // Files arrive sorted by season/episode: the first ready episode, else
    // the first that is downloading (it streams as it arrives).
    const first =
      withStatus.find(({ s }) => s.kind === "ready") ??
      withStatus.find(({ s }) => s.kind === "streaming");
    return first
      ? { file: first.f, streaming: first.s.kind === "streaming" }
      : null;
  }
  const ready = withStatus.filter(({ s }) => s.kind === "ready");
  if (ready.length > 0) {
    const best = ready.reduce((a, b) => (rank(b.f) > rank(a.f) ? b : a));
    return { file: best.f, streaming: false };
  }
  const streaming = withStatus.filter(({ s }) => s.kind === "streaming");
  if (streaming.length === 0) return null;
  const furthest = streaming.reduce((a, b) =>
    (b.s.kind === "streaming" ? b.s.pct : 0) >
    (a.s.kind === "streaming" ? a.s.pct : 0)
      ? b
      : a,
  );
  return { file: furthest.f, streaming: true };
}

/** A title's one hue, shared by its poster, its page and the room. Wider
 * than the file-row swatch (posters are the content, not chrome) but
 * muted, and never in gold's band, which stays the one lamp. */
export function titleColor(t: Pick<Title, "key">): string {
  let h = 2166136261;
  for (let i = 0; i < t.key.length; i++) {
    h ^= t.key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = h >>> 0;
  // 300 usable degrees: skip 25–85 (amber/gold).
  let hue = n % 300;
  if (hue >= 25) hue += 60;
  const sat = 26 + ((n >>> 9) % 14);
  const light = 25 + ((n >>> 17) % 10);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export function episodeLabel(f: TitleFile): string {
  if (f.date) return f.date;
  const eps = f.episodes;
  const e =
    eps.length === 0
      ? ""
      : eps.length === 1
        ? `E${String(eps[0]).padStart(2, "0")}`
        : `E${String(eps[0]).padStart(2, "0")}–${String(eps[eps.length - 1]).padStart(2, "0")}`;
  if (f.season === null)
    return eps.length ? `Episode ${eps.join("–")}` : f.name;
  return `S${String(f.season).padStart(2, "0")}${e}`;
}

const TAG =
  /^(\d{3,4}p|4k|uhd|web(-?dl|-?rip)?|bluray|blu-ray|brrip|bdrip|hdtv|hdrip|dvdrip|x26[45]|h\.?26[45]|hevc|avc|aac|ac3|ddp?\d?|atmos|hdr\d*|dv|repack|proper|internal|nf|amzn|dsnp|hmax|10bit)$/i;

/** The episode's own title from its file name, when it has one:
 * "Show.S01E02.Half.Loop.1080p.mkv" → "Half Loop", "02 - Half Loop.mkv" →
 * "Half Loop". Null when there is nothing beyond the number. */
export function episodeName(file: string): string | null {
  let s = file.replace(/\.[a-z0-9]{2,4}$/i, "");
  const marker = /(?:^|[\s._-])(?:s\d{1,4}e\d{1,4}(?:-?e?\d{1,4})*|\d{1,2}x\d{2,3})(?:v\d)?(?=$|[\s._-])/i.exec(s);
  if (marker) s = s.slice(marker.index + marker[0].length);
  else s = s.replace(/^\s*\d{1,4}\s*[-.]\s*/, "");
  const spaced = s.includes(" ") ? s : s.replace(/[._]/g, " ");
  const words: string[] = [];
  for (const w of spaced.trim().replace(/^[-–\s]+/, "").split(/\s+/)) {
    if (!w || TAG.test(w) || /^[[(]/.test(w)) break;
    words.push(w);
  }
  const name = words.join(" ").replace(/[-–\s]+$/, "").trim();
  return name && !/^\d+$/.test(name) ? name : null;
}

/** Seasons in order; absolute-numbered and dated episodes go under null. */
export function seasonsOf(t: Title): (number | null)[] {
  const set = new Set(t.files.map((f) => f.season));
  return [...set].sort((a, b) => (a ?? 1e9) - (b ?? 1e9));
}

export function qualityBadges(q: Quality): string[] {
  const out: string[] = [];
  if (q.resolution) out.push(q.resolution === "2160p" ? "4K" : q.resolution);
  if (q.hdr) out.push("HDR");
  if (q.codec) out.push(q.codec);
  if (q.source) out.push(q.source);
  return out;
}

const LANGS: Record<string, string> = {
  te: "Telugu",
  ta: "Tamil",
  hi: "Hindi",
  ml: "Malayalam",
  kn: "Kannada",
  bn: "Bengali",
  mr: "Marathi",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  multi: "Multi-audio",
};
export const languageName = (code: string) => LANGS[code] ?? code;
