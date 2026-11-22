// Recognising things the user can add: magnet links, bare info hashes,
// .torrent URLs and .torrent files.

/** Same limit as the server (adding.rs TORRENT_MAX_BYTES). */
export const TORRENT_MAX_BYTES = 16 * 1024 * 1024;

export interface MagnetInfo {
  /** Info hash for display: lowercase hex, or uppercase base32. */
  hash: string;
  /** `dn` (display name) when present. Untrusted: render as text only. */
  name: string | null;
}

const HEX40 = /^[0-9a-f]{40}$/i;
const B32 = /^[a-z2-7]{32}$/i;
const BTMH = /^1220[0-9a-f]{64}$/i;

function normaliseHash(urn: string): string | null {
  const lower = urn.toLowerCase();
  if (lower.startsWith("urn:btih:")) {
    const h = urn.slice(9);
    if (HEX40.test(h)) return h.toLowerCase();
    if (B32.test(h)) return h.toUpperCase();
    return null;
  }
  if (lower.startsWith("urn:btmh:")) {
    const h = urn.slice(9);
    return BTMH.test(h) ? h.toLowerCase() : null;
  }
  return null;
}

/** Parses a magnet link; null when it isn't one stash can add. */
export function parseMagnet(uri: string): MagnetInfo | null {
  const s = uri.trim();
  if (!/^magnet:\?/i.test(s)) return null;
  let params: URLSearchParams;
  try {
    params = new URL(s).searchParams;
  } catch {
    return null;
  }
  let hash: string | null = null;
  for (const xt of params.getAll("xt")) {
    hash = normaliseHash(xt);
    if (hash) break;
  }
  if (!hash) return null;
  const dn = params.get("dn")?.trim();
  return { hash, name: dn ? dn : null };
}

export const isInfoHash = (s: string) => HEX40.test(s) || B32.test(s);

/** Text that is clearly meant to be added: a magnet, a bare info hash, or
 * an http(s) URL whose path ends in `.torrent`. Used for paste and drop,
 * where ordinary text must be left alone. */
export function isTorrentLink(text: string): boolean {
  const s = text.trim();
  if (!s || /\s/.test(s)) return false;
  if (parseMagnet(s)) return true;
  if (isInfoHash(s)) return true;
  try {
    const u = new URL(s);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.pathname.toLowerCase().endsWith(".torrent")
    );
  } catch {
    return false;
  }
}

export const isTorrentFile = (f: File) =>
  f.name.toLowerCase().endsWith(".torrent") ||
  f.type === "application/x-bittorrent";

/** Why this batch of files can't be added, or null when all are fine. */
export function filesProblem(files: readonly File[]): string | null {
  if (files.length === 0) return "No files to add.";
  const notTorrent = files.find((f) => !isTorrentFile(f));
  if (notTorrent)
    return `Only .torrent files can be added (“${notTorrent.name}” isn't one).`;
  const big = files.find((f) => f.size > TORRENT_MAX_BYTES);
  if (big) return `“${big.name}” is larger than 16 MB.`;
  return null;
}
