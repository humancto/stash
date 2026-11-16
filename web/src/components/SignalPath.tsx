import type { Family, NetworkReport } from "../lib/api";

type Tone = "ready" | "error" | "muted";

interface Hop {
  label: string;
  detail: string;
  tone: Tone;
}

function seen(f: Family): string | null {
  if (!f.route || !f.publicIp) return null;
  return f.country ? `${f.publicIp} · ${f.country}` : f.publicIp;
}

/** The middle hop and the far end, from the kill switch first and the
 * general route second. */
function hops(r: NetworkReport): { via: Hop; peers: Hop; cut: boolean } {
  const ks = r.killSwitch;
  const ip = seen(r.ipv4) ?? seen(r.ipv6);
  const v4 = r.ipv4.route ? r.ipv4 : null;
  const iface = v4?.iface ?? null;

  if (ks?.state === "restart_failed") {
    return {
      via: { label: "Restart failed", detail: "Restart stash by hand", tone: "error" },
      peers: { label: "Peers see", detail: "Nothing", tone: "muted" },
      cut: true,
    };
  }
  if (ks?.state === "blocked" || ks?.state === "reconnecting") {
    const restarting = ks.state === "reconnecting";
    return {
      via: {
        label: restarting ? "Restarting" : "Kill switch",
        detail: restarting
          ? ks.restartReason === "settings"
            ? "Applying new settings"
            : "VPN changed"
          : "No VPN, traffic stopped",
        tone: "muted",
      },
      peers: { label: "Peers see", detail: "Nothing", tone: "muted" },
      cut: true,
    };
  }
  if (ks?.state === "bound") {
    // Only an address torrents can actually use: IPv4 through the bound
    // tunnel. An IPv6 address on Wi-Fi is not one (torrents are bound).
    const sameRoute = v4 && v4.iface === ks.boundTo ? seen(r.ipv4) : null;
    return {
      via: {
        label: ks.boundTo ?? "VPN",
        detail: "VPN tunnel, torrents only",
        tone: "ready",
      },
      peers: {
        label: "Peers see",
        detail: sameRoute ?? "The VPN's address",
        tone: "ready",
      },
      cut: false,
    };
  }
  if (ks?.state === "exposed") {
    return {
      via: {
        label: iface ?? "Network",
        detail: "Not tied to a VPN (Warn mode)",
        tone: "error",
      },
      peers: { label: "Peers see", detail: ip ?? "Your address", tone: "error" },
      cut: false,
    };
  }
  if (r.verdict === "offline") {
    return {
      via: { label: "No route", detail: "Not connected", tone: "muted" },
      peers: { label: "Peers see", detail: "Nothing", tone: "muted" },
      cut: true,
    };
  }
  const tunnel = r.verdict === "tunnel";
  return {
    via: {
      label: iface ?? "Network",
      detail: tunnel ? "Looks like a VPN tunnel" : "Not a VPN",
      tone: tunnel ? "ready" : "error",
    },
    peers: {
      label: "Peers see",
      detail: ip ?? "Unknown address",
      tone: tunnel ? "ready" : "error",
    },
    cut: false,
  };
}

/** stash → interface → the internet, drawn as the path torrent traffic takes. */
export function SignalPath({ report }: { report: NetworkReport }) {
  const { via, peers, cut } = hops(report);
  const tone = via.tone;
  return (
    <ol
      className={`path path--${tone}${cut ? " path--cut" : ""}`}
      aria-label="Path of torrent traffic"
    >
      <li className="path-hop">
        <span className="path-label">stash</span>
        <span className="path-detail">This machine</span>
      </li>
      <li className="path-link" aria-hidden="true">
        <span />
      </li>
      <li
        className={`path-hop status--${via.tone === "muted" ? "checking" : via.tone}`}
      >
        <span className="path-label num">{via.label}</span>
        <span className="path-detail">{via.detail}</span>
      </li>
      <li className="path-link" aria-hidden="true">
        <span />
      </li>
      <li
        className={`path-hop status--${peers.tone === "muted" ? "checking" : peers.tone}`}
      >
        <span className="path-label">{peers.label}</span>
        <span className="path-detail num">{peers.detail}</span>
      </li>
    </ol>
  );
}
