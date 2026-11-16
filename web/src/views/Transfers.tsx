import { ChevronDown, ChevronRight, Pause, Play } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ConfirmDelete } from "../components/ConfirmDelete";
import { NetworkSummary, useWritesPaused } from "../components/NetworkStatus";
import { Reel } from "../components/Reel";
import { api, type Transfer } from "../lib/api";
import { fileStatus } from "../lib/files";
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  percent,
} from "../lib/format";
import { stateLabel } from "../lib/seeding";
import { transfers, useTransfers } from "../lib/store";
import { statusText } from "../components/Status";

function TransferRow({ t }: { t: Transfer }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = t.stats;
  const pct = s ? percent(s.progressBytes, s.totalBytes) : 0;
  const paused = s?.state === "paused" || s?.state === "initializing_paused";
  const speed =
    s?.live && !s.finished ? formatSpeed(s.live.downloadSpeedMiBps) : "";
  const eta =
    s?.live && !s.finished
      ? formatEta(s.totalBytes - s.progressBytes, s.live.downloadSpeedMiBps)
      : "";
  const name = t.name ?? t.infoHash;
  const tone =
    s?.state === "error"
      ? "status--error"
      : s?.finished
        ? "status--ready"
        : paused
          ? "status--paused"
          : "status--streaming";
  const files = (t.files ?? [])
    .map((f, fid) => ({ f, fid }))
    .filter(({ f }) => !f.attributes.padding && !f.attributes.hidden);

  const writesPaused = useWritesPaused();

  async function toggle() {
    if (writesPaused) return;
    setBusy(true);
    setError(null);
    try {
      await transfers.mutate(() =>
        paused ? api.start(t.id) : api.pause(t.id),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="transfer">
      <div className="transfer-head">
        <span className={tone}>
          <Reel pct={pct} size={40} label={`${name}: ${formatPercent(pct)}`} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="transfer-name" title={name}>
            {name}
          </div>
          <div className="transfer-meta num">
            <span>{stateLabel(t)}</span>
            <span>
              {formatPercent(pct)} · {formatBytes(s?.progressBytes ?? 0)} of{" "}
              {formatBytes(s?.totalBytes ?? 0)}
            </span>
            {speed && <span>{speed}</span>}
            {eta && <span>{eta}</span>}
            {s?.live?.peers != null && <span>{s.live.peers} peers</span>}
            {t.seeding && t.seeding.uploadedBytes > 0 && (
              <span>Uploaded {formatBytes(t.seeding.uploadedBytes)}</span>
            )}
            {error && <span className="status--error">{error}</span>}
          </div>
        </div>
        <div className="transfer-actions">
          {files.length > 0 && (
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
              {files.length} {files.length === 1 ? "file" : "files"}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={toggle}
            data-rove-item
            disabled={busy || s?.state === "initializing"}
            aria-disabled={writesPaused ? true : undefined}
            title={writesPaused ?? undefined}
            aria-describedby={
              writesPaused
                ? undefined
                : paused && s?.finished
                  ? `seed-hint-${t.id}`
                  : undefined
            }
          >
            {paused ? (
              <Play aria-hidden="true" />
            ) : (
              <Pause aria-hidden="true" />
            )}
            {paused ? (s?.finished ? "Seed" : "Resume") : "Pause"}
          </button>
          {paused && s?.finished && (
            <span id={`seed-hint-${t.id}`} className="visually-hidden">
              Shares it with peers again.
              {t.seeding?.stoppedByRule &&
                " The seeding rule leaves it alone until you pause it."}
            </span>
          )}
          <ConfirmDelete
            pausedReason={writesPaused ?? undefined}
            className="btn--sm"
            what={`“${name}”`}
            onConfirm={() => transfers.mutate(() => api.remove(t.id))}
          />
        </div>
      </div>
      {open && (
        <ul className="transfer-files">
          {files.map(({ f, fid }) => (
            <li key={fid}>
              <Link to={`/watch/${t.id}/${fid}`}>
                <span style={{ overflowWrap: "anywhere" }}>
                  {f.components.join("/")}
                </span>
                <span className="num" style={{ whiteSpace: "nowrap" }}>
                  {formatBytes(f.length)} · {statusText(fileStatus(t, fid, f))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Transfers() {
  const { transfers: list, loading, error } = useTransfers();
  const sorted = [...list].sort((a, b) => b.id - a.id);
  const active = list.filter(
    (t) => t.stats?.state === "live" && !t.stats.finished,
  ).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Transfers</h1>
          {!loading && (
            <p className="page-sub num">
              {list.length} {list.length === 1 ? "transfer" : "transfers"}
              {active > 0 && ` · ${active} downloading`}
            </p>
          )}
        </div>
      </div>
      <NetworkSummary />
      {error && (
        <div className="banner" role="alert">
          <span>
            Can't reach stash: {error}. Showing the last list it sent.
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void transfers.refresh()}
          >
            Retry
          </button>
        </div>
      )}
      {loading ? (
        <ul className="list skeleton" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="transfer-head">
              <span
                className="frame"
                style={{ width: 40, borderRadius: "50%", aspectRatio: "1" }}
              />
              <span className="bar" style={{ width: "50%" }} />
            </li>
          ))}
        </ul>
      ) : sorted.length === 0 && error ? null : sorted.length === 0 ? (
        <div className="empty">
          <h2>No transfers</h2>
          <p>
            Paste a magnet link or a .torrent URL in the box above to start one.
          </p>
        </div>
      ) : (
        <ul className="list" data-rove aria-label="Transfers">
          {sorted.map((t) => (
            <TransferRow key={t.id} t={t} />
          ))}
        </ul>
      )}
    </div>
  );
}
