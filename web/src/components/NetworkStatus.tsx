import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Shield,
  ShieldOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { Family, NetworkReport } from "../lib/api";
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
}

export function summarize(s: NetworkSnapshot, now: number): Summary {
  if (!s.report) {
    return s.loading
      ? { tone: "muted", word: "Checking", sentence: "Checking the network" }
      : { tone: "muted", word: "Unknown", sentence: "Network status unknown" };
  }
  if (isStale(s, NETWORK_INTERVAL_MS, now)) {
    return {
      tone: "muted",
      word: "Unknown",
      sentence: "Network status unknown: the last check failed or is old",
    };
  }
  switch (s.report.verdict) {
    case "tunnel":
      return {
        tone: "ready",
        word: "VPN tunnel",
        sentence: "Traffic leaves through what looks like a VPN tunnel",
      };
    case "exposed":
      return {
        tone: "error",
        word: "No VPN",
        sentence: "No VPN tunnel: peers see this connection's IP",
      };
    case "offline":
      return {
        tone: "muted",
        word: "Offline",
        sentence: "Offline: stash has no internet route",
      };
  }
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
      to="/transfers#network"
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

/** Full status at the top of Transfers. `id="network"` is the chip's target. */
export function NetworkPanel() {
  const snap = useNetwork();
  const location = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
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

  useEffect(() => {
    if (location.hash !== "#network") return;
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // Scroll the section: it carries the scroll margin for the sticky top bar.
    sectionRef.current?.scrollIntoView({
      block: "start",
      behavior: reduce ? "auto" : "smooth",
    });
    headingRef.current?.focus({ preventScroll: true });
  }, [location.hash, location.key]);

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
      ref={sectionRef}
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
            ref={headingRef}
            tabIndex={-1}
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
            If the VPN drops, stash keeps running and peers see your normal IP.
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

