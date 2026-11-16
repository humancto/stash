import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  what: string;
  onConfirm: () => Promise<void>;
  label?: string;
  className?: string;
  /** Why deleting is not possible right now (shown, and the click is refused). */
  pausedReason?: string | undefined;
}

/** Two-step delete without a modal: the button turns into an inline
 * confirmation that says exactly what will be removed. */
export function ConfirmDelete({ what, onConfirm, label = "Delete", className = "", pausedReason }: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // Focus moves into the confirmation, and back to Delete when it closes,
  // so keyboard and TV-remote users keep their place.
  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (wasAsking.current) triggerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn--danger ${className}`}
        aria-disabled={pausedReason ? true : undefined}
        title={pausedReason}
        onClick={() => {
          if (!pausedReason) setAsking(true);
        }}
      >
        <Trash2 aria-hidden="true" />
        {label}
      </button>
    );
  }
  return (
    <span
      className="confirm"
      role="group"
      aria-label={`Confirm delete ${what}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <span>{error ?? `Delete ${what} and its files from disk?`}</span>
      <button ref={cancelRef} type="button" className="btn btn--sm btn--quiet" onClick={() => setAsking(false)}>
        Keep
      </button>
      <button
        type="button"
        className="btn btn--sm btn--danger-solid"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onConfirm();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Delete failed");
            setBusy(false);
          }
        }}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </span>
  );
}
