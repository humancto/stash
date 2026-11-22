import { memo } from "react";
import { Link } from "react-router";
import { formatPercent } from "../lib/format";
import { Reel } from "./Reel";

export interface PosterProps {
  titleKey: string;
  title: string;
  year: number | null;
  kind: "film" | "show";
  /** e.g. "1080p" or "3 seasons"; shown at the foot of the card. */
  detail: string;
  color: string;
  /** Rounded to whole percent so an unchanged poll doesn't re-render. */
  state: "ready" | "streaming" | "paused" | "checking" | "error";
  pct: number;
}

/** Title size steps down with length so long names still fit the card. */
function sizeClass(title: string): string {
  const n = title.length;
  if (n <= 12) return "poster-title--xl";
  if (n <= 24) return "poster-title--l";
  if (n <= 44) return "poster-title--m";
  return "poster-title--s";
}

function stateWords(state: PosterProps["state"], pct: number): string {
  switch (state) {
    case "ready":
      return "ready";
    case "streaming":
      return `downloading ${formatPercent(pct)}, playable now`;
    case "paused":
      return `paused at ${formatPercent(pct)}`;
    case "checking":
      return "checking";
    case "error":
      return "error";
  }
}

/** A typographic poster: no artwork exists yet, so the title itself is the
 * picture, set on the title's own hue. One link, named in full. */
export const Poster = memo(function Poster(p: PosterProps) {
  const label = [
    p.title,
    p.year ?? undefined,
    p.kind === "film" ? "film" : "show",
    stateWords(p.state, p.pct),
  ]
    .filter((x) => x !== undefined)
    .join(", ");
  return (
    <Link
      to={`/title/${encodeURIComponent(p.titleKey)}`}
      className={`poster poster--${p.state}`}
      style={{ "--tc": p.color } as React.CSSProperties}
      data-rove-item
      data-key={p.titleKey}
      aria-label={label}
    >
      <span className="poster-art" aria-hidden="true">
        <span className="poster-grain" />
        <span className={`poster-title ${sizeClass(p.title)}`} dir="auto">
          {p.title}
        </span>
        <span className="poster-foot">
          <span className="num">
            {p.year ?? (p.kind === "show" ? "Series" : "")}
          </span>
          {p.detail && <span className="poster-detail">{p.detail}</span>}
        </span>
        {(p.state === "streaming" || p.state === "paused") && (
          <span className="poster-progress">
            <Reel pct={p.pct} size={28} label="" />
            {p.state === "streaming" && (
              <span className="poster-pill">Playable now</span>
            )}
          </span>
        )}
      </span>
    </Link>
  );
});
