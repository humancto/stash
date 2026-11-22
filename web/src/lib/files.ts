import type { TorrentFile, Transfer } from "./api";
import { percent } from "./format";

export type Kind = "video" | "audio" | "image" | "subtitle" | "other";

const EXT: Record<string, Kind> = {
  mp4: "video", m4v: "video", mkv: "video", webm: "video", mov: "video", avi: "video",
  ts: "video", m2ts: "video", wmv: "video", flv: "video", mpg: "video", mpeg: "video",
  mp3: "audio", m4a: "audio", aac: "audio", flac: "audio", wav: "audio", ogg: "audio",
  opus: "audio", alac: "audio",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", avif: "image",
  srt: "subtitle", vtt: "subtitle", ass: "subtitle", ssa: "subtitle", sub: "subtitle",
};

/** Formats browsers play natively. Others may still work (many H.264 MKVs in Chrome). */
const NATIVE = new Set(["mp4", "m4v", "webm", "mov", "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"]);

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export const kindOf = (name: string): Kind => EXT[extension(name)] ?? "other";
export const isPlayable = (name: string) => {
  const k = kindOf(name);
  return k === "video" || k === "audio";
};
export const isNativelyPlayable = (name: string) => NATIVE.has(extension(name));

export type FileStatus =
  | { kind: "ready" }
  | { kind: "streaming"; pct: number }
  | { kind: "checking" }
  | { kind: "paused"; pct: number }
  | { kind: "skipped" }
  | { kind: "error"; message: string };

/** Status of one file, from its own progress rather than the whole transfer's. */
export function fileStatus(t: Transfer, fid: number, file: TorrentFile): FileStatus {
  if (!file.included) return { kind: "skipped" };
  const s = t.stats;
  if (!s) return { kind: "checking" };
  const done = s.fileProgress[fid] ?? 0;
  const pct = percent(done, file.length);
  const complete = file.length === 0 || done >= file.length;
  switch (s.state) {
    case "error":
      return { kind: "error", message: s.error ?? "Transfer failed" };
    case "initializing":
    case "initializing_paused":
      return { kind: "checking" };
    case "paused":
      return complete ? { kind: "ready" } : { kind: "paused", pct };
    case "live":
      return complete ? { kind: "ready" } : { kind: "streaming", pct };
  }
}

export interface FileEntry {
  key: string;
  tid: number;
  fid: number;
  name: string; // last path component
  path: string; // full path inside the torrent
  transferName: string;
  length: number;
  kind: Kind;
  status: FileStatus;
  /** The transfer's only remaining file: deleting it means deleting the
   * transfer (the server refuses to delete the last file). */
  sole: boolean;
}

/** Files a person sees: not padding, not hidden, not deleted. Matches the
 * server's last-file rule. */
export function shownFiles(t: Transfer): { f: TorrentFile; fid: number }[] {
  return (t.files ?? [])
    .map((f, fid) => ({ f, fid }))
    .filter(({ f, fid }) => !f.attributes.padding && !f.attributes.hidden && !isDeleted(t, fid));
}

/** Excluded files are deleted: stash never adds with a file selection. */
export const isDeleted = (t: Transfer, fid: number): boolean =>
  t.deleted.includes(fid) || t.files?.[fid]?.included === false;

/** Every visible file across transfers, newest transfer first. */
export function flatten(transfers: Transfer[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const t of [...transfers].sort((a, b) => b.id - a.id)) {
    const shown = shownFiles(t);
    shown.forEach(({ f, fid }) => {
      const name = f.components[f.components.length - 1] ?? f.name;
      out.push({
        key: `${t.id}:${fid}`,
        tid: t.id,
        fid,
        name,
        path: f.components.join("/"),
        transferName: t.name ?? t.infoHash.slice(0, 12),
        length: f.length,
        kind: kindOf(name),
        status: fileStatus(t, fid, f),
        sole: shown.length === 1,
      });
    });
  }
  return out;
}

export type Filter = "all" | "video" | "audio" | "other";
export type Sort = "recent" | "name" | "size";

export function selectFiles(all: FileEntry[], filter: Filter, query: string, sort: Sort): FileEntry[] {
  const q = query.trim().toLowerCase();
  const picked = all.filter((f) => {
    if (filter === "video" && f.kind !== "video") return false;
    if (filter === "audio" && f.kind !== "audio") return false;
    if (filter === "other" && (f.kind === "video" || f.kind === "audio")) return false;
    return !q || f.path.toLowerCase().includes(q) || f.transferName.toLowerCase().includes(q);
  });
  if (sort === "name") picked.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sort === "size") picked.sort((a, b) => b.length - a.length);
  return picked; // "recent" keeps flatten's order
}

/** A stable generated colour per file name, used until real frames exist.
 * This is not artwork: it only gives each row and the player room a hue. */
export function swatch(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Harbour-night band (slate blue to teal), varied in lightness, so tiles
  // sit in Kiri's navy palette and leave gold to the accent; the icon
  // carries the file type.
  const n = h >>> 0;
  const hue = 190 + (n % 40);
  const light = 22 + ((n >>> 8) % 12);
  return `hsl(${hue} 24% ${light}%)`;
}
