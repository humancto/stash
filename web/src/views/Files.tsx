import { File, FileText, Image, Music, Play } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { ConfirmDelete } from "../components/ConfirmDelete";
import { useWritesPaused } from "../components/NetworkStatus";
import { Status } from "../components/Status";
import { api } from "../lib/api";
import {
  flatten,
  selectFiles,
  swatch,
  type FileEntry,
  type Filter,
  type Kind,
  type Sort,
} from "../lib/files";
import { extension } from "../lib/files";
import { formatBytes } from "../lib/format";
import { transfers, useTransfers } from "../lib/store";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "other", label: "Other" },
];

function KindIcon({ kind }: { kind: Kind }) {
  switch (kind) {
    case "video":
      return <Play aria-hidden="true" />;
    case "audio":
      return <Music aria-hidden="true" />;
    case "image":
      return <Image aria-hidden="true" />;
    case "subtitle":
      return <FileText aria-hidden="true" />;
    case "other":
      return <File aria-hidden="true" />;
  }
}

interface RowProps {
  f: FileEntry;
  pausedReason: string | null;
  /** Stable across renders (see Files), so the memo can ignore it. */
  onDelete: (f: FileEntry) => Promise<void>;
}

const FileRow = memo(function FileRow({ f, pausedReason, onDelete }: RowProps) {
  return (
    <li className="file-item">
      <Link
        className="row"
        to={`/watch/${f.tid}/${f.fid}`}
        data-rove-item
        data-key={f.key}
      >
        <span
          className="frame"
          style={{ "--sw": swatch(f.name) } as React.CSSProperties}
        >
          <KindIcon kind={f.kind} />
        </span>
        <span className="row-name">
          <span className="row-title" title={f.path}>
            {f.name}
          </span>
          <span className="row-meta">
            {f.transferName}
            <span className="meta-size num"> · {formatBytes(f.length)}</span>
          </span>
        </span>
        <span className="cell cell--fmt">{extension(f.name) || "file"}</span>
        <span className="cell cell--size num">{formatBytes(f.length)}</span>
        <span className="cell">
          <Status status={f.status} />
        </span>
      </Link>
      <ConfirmDelete
        className="btn--quiet btn--sm row-delete"
        label=""
        what={f.sole ? `the whole transfer “${f.transferName}”` : `“${f.name}”`}
        ariaLabel={
          f.sole ? `Delete transfer “${f.transferName}”` : `Delete “${f.name}”`
        }
        prompt={
          f.sole
            ? `Delete the whole transfer “${f.transferName}” from disk?`
            : "Delete this file from disk? stash won't download it again."
        }
        pausedReason={pausedReason ?? undefined}
        onConfirm={() => onDelete(f)}
      />
    </li>
  );
}, sameRow);

function sameRow(a: RowProps, b: RowProps) {
  return (
    a.pausedReason === b.pausedReason &&
    a.f.sole === b.f.sole &&
    a.f.key === b.f.key &&
    a.f.name === b.f.name &&
    a.f.path === b.f.path &&
    a.f.transferName === b.f.transferName &&
    a.f.length === b.f.length &&
    a.f.kind === b.f.kind &&
    JSON.stringify(a.f.status) === JSON.stringify(b.f.status)
  );
}

function Skeleton() {
  return (
    <ul className="list skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="row">
          <span className="frame" />
          <span className="row-name">
            <span
              className="bar"
              style={{ width: `${40 + ((i * 17) % 35)}%` }}
            />
          </span>
          <span className="bar" />
          <span className="bar" />
          <span className="bar" />
        </li>
      ))}
    </ul>
  );
}

export function Files() {
  const { transfers: list, loading, error } = useTransfers();
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.find((x) => x.id === params.get("type"))?.id ??
    "all");
  const sortParam = params.get("sort");
  const sort: Sort =
    sortParam === "name" || sortParam === "size" ? sortParam : "recent";
  const q = params.get("q") ?? "";

  const all = useMemo(() => flatten(list), [list]);
  const shown = useMemo(
    () => selectFiles(all, filter, q, sort),
    [all, filter, q, sort],
  );

  const writesPaused = useWritesPaused();
  // After a delete the row unmounts, so focus would fall to <body> (lost on
  // a TV). Remember where it should go and move it once the row is gone.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const deleting = useRef<{ key: string; next: string | null } | null>(null);
  const emptyRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [announce, setAnnounce] = useState("");

  const onDelete = useCallback(async (f: FileEntry) => {
    const rows = shownRef.current;
    const i = rows.findIndex((r) => r.key === f.key);
    const next = rows[i + 1] ?? rows[i - 1] ?? null;
    deleting.current = { key: f.key, next: next?.key ?? null };
    try {
      await transfers.mutate(() =>
        f.sole ? api.remove(f.tid) : api.removeFile(f.tid, f.fid),
      );
      setAnnounce(f.sole ? `Deleted transfer “${f.transferName}”` : `Deleted “${f.name}”`);
    } catch (e) {
      deleting.current = null;
      throw e;
    }
  }, []);

  useLayoutEffect(() => {
    const d = deleting.current;
    if (!d || shown.some((r) => r.key === d.key)) return;
    deleting.current = null;
    const target = d.next
      ? listRef.current?.querySelector<HTMLElement>(`[data-key="${d.next}"]`)
      : null;
    (target ?? emptyRef.current ?? listRef.current?.querySelector<HTMLElement>("[data-rove-item]"))?.focus();
  }, [shown]);

  // Arriving from a delete on the file page: put focus in the list, not on
  // <body> (where a TV remote can't continue).
  const location = useLocation();
  const focusList =
    (location.state as { focusList?: boolean } | null)?.focusList === true;
  const focusedOnArrival = useRef(false);
  useEffect(() => {
    if (!focusList || loading || focusedOnArrival.current) return;
    focusedOnArrival.current = true;
    (listRef.current?.querySelector<HTMLElement>("[data-rove-item]") ?? emptyRef.current)?.focus();
  }, [focusList, loading]);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Files</h1>
          {!loading && (
            <p className="page-sub num">
              {shown.length === all.length
                ? `${all.length} files`
                : `${shown.length} of ${all.length} files`}
            </p>
          )}
        </div>
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="Filter by type">
            {FILTERS.map((x) => (
              <button
                key={x.id}
                type="button"
                className="tab"
                aria-pressed={filter === x.id}
                onClick={() => set("type", x.id === "all" ? null : x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
          <label className="visually-hidden" htmlFor="sort">
            Sort
          </label>
          <select
            id="sort"
            className="select"
            value={sort}
            onChange={(e) =>
              set("sort", e.target.value === "recent" ? null : e.target.value)
            }
          >
            <option value="recent">Recently added</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
        </div>
      </div>

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
        <Skeleton />
      ) : all.length === 0 && error ? null : all.length === 0 ? (
        <div className="empty">
          <h2 ref={emptyRef} tabIndex={-1}>
            Nothing here yet
          </h2>
          <p>
            Paste a magnet link in the box above. Files show up here as soon as
            the transfer knows what's inside, and video can play while it
            downloads.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <h2 ref={emptyRef} tabIndex={-1}>
            No files match
          </h2>
          <p>
            {q ? `Nothing matches “${q}” in ` : "Nothing in "}
            {filter === "all"
              ? "your files"
              : FILTERS.find((x) => x.id === filter)?.label.toLowerCase()}
            .
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <ul className="list" data-rove aria-label="Files" ref={listRef}>
          {shown.map((f) => (
            <FileRow
              key={f.key}
              f={f}
              pausedReason={writesPaused}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
