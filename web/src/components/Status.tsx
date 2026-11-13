import type { FileStatus } from "../lib/files";
import { formatPercent } from "../lib/format";
import { Reel } from "./Reel";

export function statusText(s: FileStatus): string {
  switch (s.kind) {
    case "ready":
      return "Ready";
    case "streaming":
      return `Streaming ${formatPercent(s.pct)}`;
    case "paused":
      return `Paused at ${formatPercent(s.pct)}`;
    case "checking":
      return "Checking";
    case "skipped":
      return "Not downloaded";
    case "error":
      return "Error";
  }
}

/** Status is always a word; colour and the reel only reinforce it. */
export function Status({ status }: { status: FileStatus }) {
  const text = statusText(status);
  return (
    <span className={`status status--${status.kind}`} title={status.kind === "error" ? status.message : undefined}>
      {status.kind === "streaming" || status.kind === "paused" ? (
        <Reel pct={status.pct} size={18} label={text} />
      ) : (
        <span className="status-dot" aria-hidden="true" />
      )}
      <span className="num">{text}</span>
    </span>
  );
}
