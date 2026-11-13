interface Props {
  pct: number;
  size?: number;
  label: string;
}

/** Progress drawn as a film reel: the rim fills as the transfer completes;
 * larger reels show the hub and spoke holes, like the stash mark. */
export function Reel({ pct, size = 28, label }: Props) {
  const c = size / 2;
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  const detailed = size >= 28;
  const spoke = r * 0.52;
  const holeR = Math.max(1.6, size * 0.075);
  return (
    <svg
      className="reel"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <circle className="reel-track" cx={c} cy={c} r={r} />
      <circle
        className="reel-fill"
        cx={c}
        cy={c}
        r={r}
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - clamped / 100)}
        transform={`rotate(-90 ${c} ${c})`}
      />
      {detailed && (
        <g className="reel-hub">
          <circle cx={c} cy={c} r={holeR * 0.9} />
          {[0, 120, 240].map((deg) => {
            const a = (deg * Math.PI) / 180;
            return <circle key={deg} cx={c + spoke * Math.sin(a)} cy={c - spoke * Math.cos(a)} r={holeR} />;
          })}
        </g>
      )}
    </svg>
  );
}
