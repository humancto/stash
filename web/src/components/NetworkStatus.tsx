import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Shield,
  ShieldOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Family, KillSwitch, NetworkReport } from "../lib/api";
import {
  NETWORK_INTERVAL_MS,
  isStale,
  network,
  useNetwork,
  type NetworkSnapshot,
} from "../lib/network";

type Tone = "ready" | "error" | "muted";

interface Summary {
  tone: Tone;
  /** One or two words for the chip. */
  word: string;
  /** Sentence used for the accessible name and announcements. */
  sentence: string;
  /** The part after the word, for one-line summaries. */
  detail: string;
}

const sum = (tone: Tone, word: string, detail: string): Summary => ({
  tone,
  word,
  detail,
  sentence: `${word}: ${detail}`,
});

export function summarize(s: NetworkSnapshot, now: number): Summary {
  if (!s.report) {
    return s.loading
      ? sum("muted", "Checking", "finding out what peers can see")
      : sum("muted", "Unknown", "network status unknown");
  }
  if (isStale(s, NETWORK_INTERVAL_MS, now)) {
    return sum("muted", "Unknown", "network status unknown, the last check failed or is old");
  }
  const ks = s.report.killSwitch;
  switch (ks?.state) {
    case "reconnecting":
      return ks.restartReason === "settings"
        ? sum("muted", "Restarting", "applying new settings, torrents are stopped for a moment")
        : sum("muted", "Reconnecting", "the VPN changed, torrents are stopped for a moment");
    case "blocked":
      return sum("muted", "Stopped", "no VPN, so the kill switch has stopped torrents");
    case "restart_failed":
      return sum("error", "Restart failed", "stash couldn't restart itself, torrents are stopped. Restart stash by hand");
    case "bound":
      return sum("ready", "VPN only", `torrents use ${ks.boundTo ?? "the VPN"} and nothing else`);
    case "exposed":
      return sum("error", "No VPN", "torrents use your normal connection and peers see your IP");
    default:
      break;
  }
  switch (s.report.verdict) {
    case "tunnel":
      return sum("ready", "VPN tunnel", "traffic leaves through what looks like a VPN tunnel");
    case "exposed":
      return sum("error", "No VPN", "no VPN tunnel, peers see this connection's IP");
    case "offline":
      return sum("muted", "Offline", "stash has no internet route");
  }
}

/** True while add/start/pause/delete would be refused (stash restarting).
 * Only from a fresh report, like everything else that claims a state. */
export function writesPaused(s: NetworkSnapshot, now: number): boolean {
  const ks = s.report?.killSwitch;
  return !!ks && !ks.acceptingWrites && !isStale(s, NETWORK_INTERVAL_MS, now);
}

/** Live: re-renders with the network store. Null when actions work. */
export function useWritesPaused(): string | null {
  return pausedReason(useNetwork(), Date.now());
}

export const PAUSED_REASON =
  "stash is restarting. Adding, pausing and deleting work again in a moment.";

export const RESTART_FAILED_REASON =
  "stash couldn't restart itself. Restart it by hand to add, pause or delete transfers.";

/** The reason actions are unavailable right now, or null. */
export function pausedReason(s: NetworkSnapshot, now: number): string | null {
  if (!writesPaused(s, now)) return null;
  return s.report?.killSwitch?.state === "restart_failed"
    ? RESTART_FAILED_REASON
    : PAUSED_REASON;
}

function withCountry(f: Family): string | null {
  if (!f.route || !f.publicIp) return null;
  return f.country ? `${f.publicIp} (${f.country})` : f.publicIp;
}

function headline(r: NetworkReport): string {
  const v4 = withCountry(r.ipv4);
  const v6 = withCountry(r.ipv6);
  const seen = [v4, v6].filter(Boolean).join(" and ");
  const peers = seen ? `Peers see ${seen}. ` : "";
  const tunnelIface = [r.ipv4, r.ipv6].find((f) => f.route && f.tunnel);
  switch (r.verdict) {
    case "offline":
      return "stash has no internet route right now.";
    case "tunnel": {
      const name = tunnelIface?.route ? tunnelIface.iface : null;
      return `${peers}stash's traffic leaves through ${name ? `${name}, which` : "an interface that"} looks like a VPN tunnel.`;
    }
    case "exposed":
      return `${peers}stash's traffic does not leave through a VPN tunnel on the machine running stash.`;
  }
}

/** One line about the kill switch, for the panel. */
export function killLine(ks: KillSwitch | null): string | null {
  if (!ks) return null;
  switch (ks.state) {
    case "off":
      return "Kill switch is off: torrents use whatever connection this machine uses.";
    case "bound":
      return ks.level === "warn"
        ? `Torrents use ${ks.boundTo ?? "the VPN"} only. Warn mode: if the VPN drops, torrents pause, then continue on your normal connection.`
        : `Kill switch on: torrents use ${ks.boundTo ?? "the VPN"} only. If the VPN drops, they stop at once.`;
    case "blocked":
      return ks.level === "warn"
        ? "Torrents are stopped."
        : "Kill switch: no VPN, so torrents are stopped. Connect your VPN and stash picks it up within seconds.";
    case "reconnecting":
      return ks.restartReason === "settings"
        ? "Applying new settings. Torrents are stopped and stash restarts in a moment."
        : "The VPN changed. Torrents are stopped and stash restarts in a moment.";
    case "exposed":
      return "Warn mode: no VPN, so torrents are running on your normal connection.";
    case "restart_failed":
      return "stash couldn't restart itself (was it updated while running?). Torrents stay stopped until you restart stash by hand.";
  }
}

const clock = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

/** Compact status in the rail. No IP here: the rail is visible in screen shares. */
export function NetworkChip() {
  const snap = useNetwork();
  const s = summarize(snap, Date.now());
  const Icon = s.tone === "error" ? ShieldOff : Shield;
  return (
    <Link
      to="/privacy"
      className={`net-chip status--${s.tone === "muted" ? "checking" : s.tone}`}
      aria-label={`Network: ${s.sentence}. View details`}
      title={`Network: ${s.word}`}
      data-rove-item
    >
      <span className="net-chip-icon" aria-hidden="true">
        <Icon />
        <span className="status-dot" />
      </span>
      <span className="net-chip-word">{s.word}</span>
    </Link>
  );
}

function FamilyRow({
  label,
  f,
  lookupEnabled,
}: {
  label: string;
  f: Family;
  lookupEnabled: boolean;
}) {
  if (!f.route) {
    return (
      <div className="net-row">
        <dt>{label}</dt>
        <dd className="net-dim">No {label} route</dd>
      </div>
    );
  }
  return (
    <div className="net-row">
      <dt>{label}</dt>
      <dd>
        <span className={f.tunnel ? "status--ready" : "status--error"}>
          {f.iface ?? "Unknown interface"} ·{" "}
          {f.tunnel ? "looks like a VPN tunnel" : "not a tunnel"}
        </span>
        <span className="num net-dim">This machine: {f.localIp}</span>
        {lookupEnabled &&
          (f.publicIp ? (
            <span className="num">
              Peers see: {f.publicIp}
              {f.country ? ` (${f.country})` : ""}
            </span>
          ) : (
            <span className="net-dim">{f.error ?? "Public IP unknown"}</span>
          ))}
        {!f.routeConsistent && (
          <span className="net-dim">Some traffic takes a different route.</span>
        )}
      </dd>
    </div>
  );
}

/** Full status on the Privacy page. */
export function NetworkPanel() {
  const snap = useNetwork();
  const [open, setOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const prevVerdict = useRef<string | null>(null);
  const userAsked = useRef(false);
  const s = summarize(snap, Date.now());
  const r = snap.report;
  // A stale report shows no verdict anywhere, details included.
  const fresh = r && !isStale(snap, NETWORK_INTERVAL_MS, Date.now()) ? r : null;

  // The rail chip polls slowly; opening the panel freshens a report older than 30 s.
  useEffect(() => network.checkIfOlder(30_000), []);


  // Announce verdict changes after the first load, and the result of "Check again".
  useEffect(() => {
    if (snap.loading || snap.refreshing) return;
    const key = s.word;
    if (
      userAsked.current ||
      (prevVerdict.current !== null && prevVerdict.current !== key)
    ) {
      const msg = `${s.sentence}.`;
      // Same text twice doesn't change the DOM; nudge it so it is re-read.
      setAnnounce((prev) => (prev === msg ? `${msg}\u00a0` : msg));
    }
    userAsked.current = false;
    prevVerdict.current = key;
  }, [snap, s.word, s.sentence]);

  return (
    <section
      className="net-panel"
      id="network"
      aria-labelledby="net-heading"
    >
      <div className="net-head">
        <span
          className={`net-badge status--${s.tone === "muted" ? "checking" : s.tone}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {s.word}
        </span>
        <div className="net-text">
          <h2
            id="net-heading"
            className="net-title"
          >
            {fresh
              ? headline(fresh)
              : snap.loading
                ? "Checking what peers can see…"
                : snap.error || !r
                  ? "Couldn't check what peers can see."
                  : "The last check is out of date."}
          </h2>
          <p className="net-sub num">
            {snap.error && (
              <span className="status--error">
                {snap.error.replace(/\.$/, "")}.{" "}
              </span>
            )}
            {r && `Checked ${clock(r.checkedAt)}. `}
            {r &&
              !r.lookupEnabled &&
              "Public IP lookup is off (STASH_IP_LOOKUP). "}
            {killLine(r?.killSwitch ?? null) ??
              "If the VPN drops, stash keeps running and peers see your normal IP."}
          </p>
        </div>
        <div className="net-actions">
          {fresh && fresh.verdict !== "offline" && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              Details
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            disabled={snap.refreshing}
            onClick={() => {
              userAsked.current = true;
              void network.refresh();
            }}
          >
            <RefreshCw aria-hidden="true" />
            {snap.refreshing ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>
      {open && fresh && (
        <div className="net-details">
          <dl>
            <FamilyRow label="IPv4" f={fresh.ipv4} lookupEnabled={fresh.lookupEnabled} />
            <FamilyRow label="IPv6" f={fresh.ipv6} lookupEnabled={fresh.lookupEnabled} />
          </dl>
          <p className="net-dim">
            Checked for general internet traffic from the machine running stash. A VPN that runs on your router
            instead shows up here as "No VPN", with the VPN's address under "Peers see".
          </p>
        </div>
      )}
      <p className="visually-hidden" role="status">
        {announce}
      </p>
    </section>
  );
}

/** One line at the top of Transfers; the full panel lives on Privacy. */
export function NetworkSummary() {
  const snap = useNetwork();
  const now = Date.now();
  const s = summarize(snap, now);
  const paused = pausedReason(snap, now);
  return (
    <>
      <Link
        to="/privacy"
        className="net-summary"
        aria-label={`Network: ${s.sentence}. Open Privacy`}
      >
        <span
          className={`net-badge status--${s.tone === "muted" ? "checking" : s.tone}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {s.word}
        </span>
        <span className="net-summary-text">{s.detail}</span>
        <ChevronRight aria-hidden="true" />
      </Link>
      {/* Always in the DOM so screen readers announce the text when it appears. */}
      <div
        className={paused ? "banner banner--quiet" : "visually-hidden"}
        role="status"
      >
        {paused ?? ""}
      </div>
    </>
  );
}
