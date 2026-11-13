/** Absolute URL for a same-origin path, for players outside the browser. */
export const absoluteUrl = (path: string, origin = window.location.origin) => new URL(path, origin).toString();

/** An extended M3U playlist with one entry. */
export function m3u(title: string, url: string): string {
  const clean = title.replace(/[\r\n]+/g, " ");
  return `#EXTM3U\n#EXTINF:-1,${clean}\n${url}\n`;
}

/** VLC's URL scheme (iOS/Android/macOS VLC register it). */
export const vlcUrl = (url: string) => `vlc://${url}`;

/** Average colour of an RGBA buffer, skipping near-black pixels (letterbox
 * bars, fades). Returns null when nothing bright enough was found, so the
 * caller keeps the previous colour. */
export function averageColor(data: Uint8ClampedArray, minLuma = 24): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const pr = data[i] ?? 0;
    const pg = data[i + 1] ?? 0;
    const pb = data[i + 2] ?? 0;
    if (0.2126 * pr + 0.7152 * pg + 0.0722 * pb < minLuma) continue;
    r += pr;
    g += pg;
    b += pb;
    n++;
  }
  if (n === 0) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
