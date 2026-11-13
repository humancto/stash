const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Binary-scaled size, e.g. 276134947 -> "263.3 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`;
}

/** librqbit's `download_speed.mbps` is MiB/s (bytes * 1024^2). Labelled
 * with the same units as formatBytes (binary, shown as KB/MB) so sizes and
 * speeds read consistently. */
export function formatSpeed(mibps: number): string {
  if (!Number.isFinite(mibps) || mibps <= 0) return "";
  return mibps >= 1 ? `${mibps.toFixed(1)} MB/s` : `${Math.round(mibps * 1024)} KB/s`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

export function formatPercent(p: number): string {
  return p >= 99.95 ? "100%" : `${p < 10 ? p.toFixed(1) : Math.floor(p)}%`;
}

/** Seconds remaining at the current speed, e.g. "4 min left". */
export function formatEta(remainingBytes: number, mibps: number): string {
  if (mibps <= 0 || remainingBytes <= 0) return "";
  const s = remainingBytes / (mibps * 1024 * 1024);
  if (s < 60) return "under a minute left";
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.round((s % 3600) / 60)} min left`;
}
