import { Play } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router";
import { Poster } from "../components/Poster";
import { useRoom } from "../components/room";
import { api } from "../lib/api";
import {
  canPlaySome,
  isDownloading,
  languageName,
  library,
  playChoice,
  qualityBadges,
  seasonsOf,
  titleColor,
  titleState,
  useLibrary,
  type Title,
  type TitleState,
  type TransferIndex,
} from "../lib/library";

/** The poster last opened, so Back lands on it again. */
let lastPoster: string | null = null;
export const rememberPoster = (key: string) => {
  lastPoster = key;
};

const TYPES = [
  { id: "all", label: "All" },
  { id: "films", label: "Films" },
  { id: "shows", label: "Shows" },
] as const;
const STATES = [
  { id: "all", label: "Any" },
  { id: "ready", label: "Ready" },
  { id: "downloading", label: "Downloading" },
] as const;
const SORTS = [
  { id: "recent", label: "Recently added" },
  { id: "title", label: "Title" },
  { id: "year", label: "Year" },
] as const;

/** A URL parameter narrowed to one of `options`, else the first. */
function pick<T extends string>(
  options: readonly { id: T }[],
  v: string | null,
): T {
  return options.find((o) => o.id === v)?.id ?? options[0]!.id;
}

/** Accent- and case-insensitive text for search. */
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function detailOf(t: Title): string {
  if (t.kind === "show") {
    const seasons = seasonsOf(t).filter((s) => s !== null).length;
    if (seasons > 1) return `${seasons} seasons`;
    return `${t.files.length} ${t.files.length === 1 ? "episode" : "episodes"}`;
  }
  const best = t.files.map((f) => f.quality.resolution).find(Boolean);
  return best === "2160p" ? "4K" : (best ?? "");
}

function sameState(a: TitleState, b: TitleState): boolean {
  if (a.kind !== b.kind) return false;
  if (
    (a.kind === "streaming" || a.kind === "paused") &&
    (b.kind === "streaming" || b.kind === "paused")
  )
    return Math.floor(a.pct) === Math.floor(b.pct);
  return true;
}

/** Re-renders only when the title or its rounded state changes. */
const TitlePoster = memo(
  function TitlePoster({ t, s }: { t: Title; s: TitleState }) {
    return (
      <Poster
        titleKey={t.key}
        title={t.title}
        year={t.year}
        kind={t.kind}
        detail={detailOf(t)}
        color={titleColor(t)}
        state={s.kind}
        pct={
          s.kind === "streaming" || s.kind === "paused" ? Math.floor(s.pct) : 0
        }
      />
    );
  },
  (a, b) => a.t === b.t && sameState(a.s, b.s),
);

function Shelf({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="shelf" aria-labelledby={id}>
      <h2 className="shelf-title" id={id}>
        {heading}
      </h2>
      <ul className="shelf-row" data-rove="grid">
        {children}
      </ul>
    </section>
  );
}

/** The newest title that can play, lighting the room in its hue. */
function Spotlight({ t, byId }: { t: Title; byId: TransferIndex }) {
  const room = useRoom();
  const color = titleColor(t);
  useEffect(() => {
    room.setScreen(color);
  }, [room, color]);
  const play = playChoice(byId, t);
  const q = (play?.file ?? t.files[0])?.quality;
  const badges = q ? qualityBadges(q) : [];
  const langs =
    q?.languages.filter((l) => l !== "multi").map(languageName) ?? [];
  return (
    <section
      className="spotlight"
      style={{ "--tc": color } as React.CSSProperties}
      aria-labelledby="spotlight-title"
    >
      <div className="spotlight-text">
        <h2 className="spotlight-title" id="spotlight-title" dir="auto">
          {t.title}
        </h2>
        <p className="spotlight-meta num">
          {[t.year, t.kind === "film" ? "Film" : detailOf(t), ...langs]
            .filter(Boolean)
            .join(" · ")}
          {badges.length > 0 && (
            <span className="badges">
              {badges.map((b) => (
                <span key={b} className="badge">
                  {b}
                </span>
              ))}
            </span>
          )}
        </p>
        <div className="spotlight-actions" data-rove="grid">
          {play && (
            <Link
              className="btn btn--primary"
              data-rove-item
              to={`/watch/${play.file.tid}/${play.file.fid}`}
              state={{ from: { path: "/", label: "Library" } }}
            >
              <Play aria-hidden="true" />
              {play.streaming ? "Play while downloading" : "Play"}
            </Link>
          )}
          <Link
            className="btn"
            data-rove-item
            to={`/title/${encodeURIComponent(t.key)}`}
            onClick={() => rememberPoster(t.key)}
          >
            Details
          </Link>
        </div>
      </div>
    </section>
  );
}

function TabGroup<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {options.map((x) => (
        <button
          key={x.id}
          type="button"
          className="tab"
          data-rove-item
          aria-pressed={value === x.id}
          onClick={() => onPick(x.id)}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

export function Library() {
  const { library: lib, loading, error, byId } = useLibrary();
  const [params, setParams] = useSearchParams();
  const navType = useNavigationType();
  const [showHidden, setShowHidden] = useState(false);
  const [unhideError, setUnhideError] = useState<string | null>(null);
  const rawQ = (params.get("q") ?? "").trim();
  const q = fold(rawQ);
  const type = pick(TYPES, params.get("type"));
  const stateF = pick(STATES, params.get("state"));
  const sort = pick(SORTS, params.get("sort"));

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const titles = useMemo(() => lib?.titles ?? [], [lib]);
  const visible = useMemo(() => titles.filter((t) => !t.hidden), [titles]);
  const hidden = useMemo(() => titles.filter((t) => t.hidden), [titles]);
  const states = useMemo(
    () => new Map(titles.map((t) => [t.key, titleState(byId, t)])),
    [titles, byId],
  );
  const stateOf = (t: Title): TitleState =>
    states.get(t.key) ?? { kind: "checking" };

  const filtering = q !== "" || type !== "all" || stateF !== "all";
  const shown = useMemo(() => {
    const picked = visible.filter((t) => {
      if (type === "films" && t.kind !== "film") return false;
      if (type === "shows" && t.kind !== "show") return false;
      const s = states.get(t.key);
      if (stateF === "ready" && !(s && canPlaySome(s))) return false;
      if (stateF === "downloading" && !(s && isDownloading(s))) return false;
      return !q || fold(`${t.title} ${t.year ?? ""}`).includes(q);
    });
    if (sort === "title")
      picked.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true }),
      );
    if (sort === "year") picked.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return picked;
  }, [visible, type, stateF, q, sort, states]);

  const spotlight = useMemo(
    () => visible.find((t) => playChoice(byId, t) !== null) ?? null,
    [visible, byId],
  );
  const inProgress = visible.filter((t) => isDownloading(stateOf(t)));
  const pending = lib?.pending ?? [];
  // This week's additions, when that's a subset worth its own shelf.
  const weekAgo = Date.now() / 1000 - 7 * 24 * 3600;
  const recentAll = visible.filter((t) => t.added >= weekAgo);
  const recent =
    recentAll.length < visible.length ? recentAll.slice(0, 12) : [];

  // Back from a title page: focus the poster that was opened. Once per
  // arrival, when the first library is there, never on later refetches.
  // After a title vanished (its last file deleted), the first poster.
  const location = useLocation();
  const restored = useRef<string | null>(null);
  const focusFirst =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusFirst" in location.state &&
    location.state.focusFirst === true;
  useEffect(() => {
    if (!lib || restored.current === location.key) return;
    restored.current = location.key;
    let el: HTMLElement | null = null;
    if (navType === "POP" && lastPoster)
      el = document.querySelector<HTMLElement>(`.library [data-key="${CSS.escape(lastPoster)}"]`);
    else if (focusFirst) el = document.querySelector<HTMLElement>(".library .poster");
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }, [navType, lib, location.key, focusFirst]);

  const onPick = (e: React.MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    const key = e.target.closest<HTMLElement>("[data-key]")?.dataset["key"];
    if (key) rememberPoster(key);
  };

  async function unhide(key: string) {
    setUnhideError(null);
    try {
      await api.unhideTitle(key);
      await library.refresh();
    } catch (e) {
      setUnhideError(
        e instanceof Error ? e.message : "Could not show it again.",
      );
    }
  }

  if (loading && !lib) {
    return (
      <div className="page library" aria-busy="true">
        <div className="spotlight skeleton" />
      </div>
    );
  }

  if (error && !lib) {
    return (
      <div className="page library">
        <div className="empty" role="alert">
          <h2>Can't load the Library</h2>
          <p>{error}. It will try again when transfers change.</p>
          <button
            type="button"
            className="btn"
            onClick={() => void library.refresh()}
          >
            Retry now
          </button>
        </div>
      </div>
    );
  }

  // Nothing visible to show; hidden titles still get their way back below.
  const nothing = visible.length === 0 && pending.length === 0;
  const others = lib?.otherFiles ?? 0;

  return (
    <div className="page library" onClickCapture={onPick}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Library</h1>
          {lib && (
            <p className="page-sub num">
              {[
                `${visible.filter((t) => t.kind === "film").length} films`,
                `${visible.filter((t) => t.kind === "show").length} shows`,
                inProgress.length > 0
                  ? `${inProgress.length} downloading`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
        {!nothing && (
          <div className="toolbar" data-rove="grid">
            <TabGroup
              label="Show"
              options={TYPES}
              value={type}
              onPick={(v) => set("type", v === "all" ? null : v)}
            />
            <TabGroup
              label="State"
              options={STATES}
              value={stateF}
              onPick={(v) => set("state", v === "all" ? null : v)}
            />
            <label className="visually-hidden" htmlFor="library-sort">
              Sort
            </label>
            <select
              id="library-sort"
              className="select"
              value={sort}
              onChange={(e) =>
                set("sort", e.target.value === "recent" ? null : e.target.value)
              }
            >
              {SORTS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && (
        <div className="banner" role="alert">
          <span>Can't refresh the Library: {error}. Showing the last one.</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void library.refresh()}
          >
            Retry
          </button>
        </div>
      )}

      {nothing ? (
        <div className="empty">
          {hidden.length > 0 ? (
            <>
              <h2>Everything is hidden</h2>
              <p>Show hidden titles again below.</p>
            </>
          ) : others > 0 ? (
            <>
              <h2>No films or shows yet</h2>
              <p>
                stash found {others} {others === 1 ? "video" : "videos"} that{" "}
                {others === 1 ? "isn't" : "aren't"} a film or an episode.
              </p>
              <Link className="btn" to="/files">
                See Files
              </Link>
            </>
          ) : (
            <>
              <h2>Your library is empty</h2>
              <p>
                Paste a magnet link in the box above, paste one anywhere, or
                drop a .torrent file on the page. Films and shows appear here as
                soon as their names are known.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {!filtering && spotlight && <Spotlight t={spotlight} byId={byId} />}

          {!filtering && (inProgress.length > 0 || pending.length > 0) && (
            <Shelf id="shelf-downloading" heading="Downloading">
              {inProgress.map((t) => (
                <li key={t.key}>
                  <TitlePoster t={t} s={stateOf(t)} />
                </li>
              ))}
              {pending.map((tid) => {
                const name = byId.get(tid)?.name ?? "New transfer";
                return (
                  <li key={`p${tid}`}>
                    <Link
                      to="/transfers"
                      className="poster poster--pending"
                      data-rove-item
                      aria-label={`${name}, fetching details`}
                    >
                      <span className="poster-art" aria-hidden="true">
                        <span className="poster-title poster-title--s">
                          {name}
                        </span>
                        <span className="poster-foot">Fetching details…</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </Shelf>
          )}

          {!filtering && recent.length > 0 && (
            <Shelf id="shelf-recent" heading="Recently added">
              {recent.map((t) => (
                <li key={t.key}>
                  <TitlePoster t={t} s={stateOf(t)} />
                </li>
              ))}
            </Shelf>
          )}

          <section className="shelf" aria-labelledby="all-titles">
            <h2 className="shelf-title" id="all-titles">
              {filtering
                ? `${shown.length} ${shown.length === 1 ? "title" : "titles"}`
                : "All titles"}
            </h2>
            {shown.length === 0 ? (
              <p className="shelf-empty">
                Nothing matches.{" "}
                {rawQ && (
                  <Link to={`/files?q=${encodeURIComponent(rawQ)}`}>
                    Search files instead
                  </Link>
                )}
              </p>
            ) : (
              <ul className="poster-grid" data-rove="grid">
                {shown.map((t) => (
                  <li key={t.key}>
                    <TitlePoster t={t} s={stateOf(t)} />
                  </li>
                ))}
              </ul>
            )}
            {rawQ && shown.length > 0 && (
              <p className="shelf-more">
                <Link to={`/files?q=${encodeURIComponent(rawQ)}`}>
                  Search files for “{rawQ}” →
                </Link>
              </p>
            )}
          </section>
        </>
      )}

      {(hidden.length > 0 || (others > 0 && !nothing)) && (
        <footer className="library-foot">
          {hidden.length > 0 && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((v) => !v)}
            >
              Hidden ({hidden.length})
            </button>
          )}
          {others > 0 && !nothing && (
            <Link className="btn btn--quiet btn--sm" to="/files">
              {others} other {others === 1 ? "video" : "videos"} in Files
            </Link>
          )}
        </footer>
      )}
      {unhideError && (
        <p className="add-error" role="alert">
          {unhideError}
        </p>
      )}
      {showHidden && hidden.length > 0 && (
        <ul className="hidden-list" aria-label="Hidden titles" data-rove>
          {hidden.map((t) => (
            <li key={t.key} className="hidden-row">
              <span dir="auto">
                {t.title}
                {t.year ? ` (${t.year})` : ""}
              </span>
              <button
                type="button"
                className="btn btn--sm"
                data-rove-item
                onClick={() => void unhide(t.key)}
              >
                Show in Library
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
