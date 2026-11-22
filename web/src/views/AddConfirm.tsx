import { Magnet } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useWritesPaused } from "../components/NetworkStatus";
import { useAddAndGo } from "../lib/useAddAndGo";
import { useAdder } from "../lib/adder";
import { parseMagnet } from "../lib/magnet";

/** Clicks within this long after the page opens are ignored: another page
 * can open /add while the user is pressing Enter or OK (keyjacking). */
export const ADD_GUARD_MS = 500;

/** Target of the browser's magnet: handler. Never adds on its own: any web
 * page can send a tab here, so the user confirms. */
export function AddConfirm() {
  const [params] = useSearchParams();
  const uri = params.get("uri") ?? "";
  const info = parseMagnet(uri);
  const navigate = useNavigate();
  const addAndGo = useAddAndGo();
  const { busy, error } = useAdder();
  const writesPaused = useWritesPaused();
  const opened = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const badRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    opened.current = Date.now();
    // Focus starts on Cancel: a key already held down (or pressed as the
    // page opened) must not land on Add.
    (cancelRef.current ?? badRef.current)?.focus();
  }, [uri]);

  if (!info) {
    return (
      <div className="page add-confirm">
        <h1 className="page-title" ref={badRef} tabIndex={-1}>
          That isn't a magnet link
        </h1>
        <p className="page-sub">stash can only add magnet links from here.</p>
        <p>
          <Link to="/files" className="btn">
            Back to Files
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="page add-confirm">
      <div className="add-confirm-card">
        <Magnet className="add-confirm-icon" aria-hidden="true" />
        <h1 className="page-title">Add this torrent?</h1>
        {info.name && (
          <p className="add-confirm-name" dir="auto">
            {info.name}
          </p>
        )}
        <p className="add-confirm-hash">
          <span className="visually-hidden">Info hash </span>
          <code className="num">{info.hash}</code>
        </p>
        <p className="add-confirm-note">
          A web page sent you here. Add it only if you meant to.
        </p>
        <div className="add-confirm-actions" data-rove>
          <button
            type="button"
            className="btn btn--primary"
            data-rove-item
            aria-disabled={busy || writesPaused ? true : undefined}
            title={writesPaused ?? undefined}
            onKeyDown={(e) => {
              // Auto-repeat from a held key is not a decision.
              if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
            }}
            onClick={() => {
              if (busy || Date.now() - opened.current < ADD_GUARD_MS) return;
              void addAndGo({ kind: "url", url: uri });
            }}
          >
            {busy ? "Adding…" : "Add torrent"}
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            data-rove-item
            onClick={() => void navigate("/files")}
          >
            Cancel
          </button>
        </div>
        {error && (
          <p className="add-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
