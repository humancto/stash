import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigationType, useSearchParams } from "react-router";
import { Poster } from "../components/Poster";
import { useRoom } from "../components/room";
import type { Transfer } from "../lib/api";
import {
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
} from "../lib/library";
import { api } from "../lib/api";

/** The poster last opened, so Back lands on it again. */
let lastPoster: string | null = null;
export const rememberPoster = (key: string) => {
  lastPoster = key;
};

type TypeFilter = "all" | "films" | "shows";
type StateFilter = "all" | "ready" | "downloading";
type SortBy = "recent" | "title" | "year";

const TYPES: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "films", label: "Films" },
  { id: "shows", label: "Shows" },
];
const STATES: { id: StateFilter; label: string }[] = [
  { id: "all", label: "Any" },
  { id: "ready", label: "Ready" },
  { id: "downloading", label: "Downloading" },
];

function detailOf(t: Title): string {
  if (t.kind === "show") {
    const seasons = seasonsOf(t).filter((s) => s !== null).length;
    if (seasons > 1) return `${seasons} seasons`;
    return `${t.files.length} ${t.files.length === 1 ? "episode" : "episodes"}`;
  }
  const best = t.files.map((f) => f.quality.resolution).find(Boolean);
  return best === "2160p" ? "4K" : (best ?? "");
}

const posterState = (s: TitleState) => ({
  state: s.kind,
  pct: s.kind === "streaming" || s.kind === "paused" ? Math.floor(s.pct) : 0,
});

function TitlePoster({ t, list }: { t: Title; list: Transfer[] }) {
  const { state, pct } = posterState(titleState(list, t));
  return (
    <Poster
      titleKey={t.key}
      title={t.title}
      year={t.year}
      kind={t.kind}
      detail={detailOf(t)}
      color={titleColor(t)}
      state={state}
      pct={pct}
    />
  );
}

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

/** The newest title that can play, given the room's light. */
function Spotlight({ t, list }: { t: Title; list: Transfer[] }) {
  const room = useRoom();
  const color = titleColor(t);
  useEffect(() => {
    room.setScreen(color);
  }, [room, color]);
  const play = playChoice(list, t);
  const q = t.files[0]?.quality;
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
        <div className="spotlight-actions" data-rove>
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

export function Library() {
  const { library: lib, loading, error, transfers: list } = useLibrary();
  const [params, setParams] = useSearchParams();
  const navType = useNavigationType();
  const [showHidden, setShowHidden] = useState(false);
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const type = (params.get("type") as TypeFilter | null) ?? "all";
  const stateF = (params.get("state") as StateFilter | null) ?? "all";
  const sort = (params.get("sort") as SortBy | null) ?? "recent";

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
    () => new Map(titles.map((t) => [t.key, titleState(list, t)])),
    [titles, list],
  );
  const downloading = (t: Title) => {
    const k = states.get(t.key)?.kind;
    return k === "streaming" || k === "paused";
  };

  const filtering = q !== "" || type !== "all" || stateF !== "all";
  const shown = useMemo(() => {
    const picked = visible.filter((t) => {
      if (type === "films" && t.kind !== "film") return false;
      if (type === "shows" && t.kind !== "show") return false;
      const k = states.get(t.key)?.kind;
      if (stateF === "ready" && k !== "ready") return false;
      if (stateF === "downloading" && k !== "streaming" && k !== "paused")
        return false;
      return !q || t.title.toLowerCase().includes(q);
    });
    if (sort === "title")
      picked.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true }),
      );
    if (sort === "year") picked.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return picked;
  }, [visible, type, stateF, q, sort, states]);

  const spotlight = useMemo(
    () => visible.find((t) => playChoice(list, t) !== null) ?? null,
    [visible, list],
  );
  const inProgress = visible.filter(downloading);
  // This week's additions, when that's a subset worth its own shelf.
  const weekAgo = Date.now() / 1000 - 7 * 24 * 3600;
  const recentAll = visible.filter((t) => t.added >= weekAgo);
  const recent = recentAll.length < visible.length ? recentAll.slice(0, 12) : [];
  const pending = lib?.pending ?? [];

  // Back from a title page: focus the poster that was opened.
  useEffect(() => {
    if (navType !== "POP" || !lastPoster || loading) return;
    const el = document.querySelector<HTMLElement>(
      `.library [data-key="${CSS.escape(lastPoster)}"]`,
    );
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }, [navType, loading]);

  const onPick = (e: React.MouseEvent) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")
      ?.dataset["key"];
    if (key) rememberPoster(key);
  };

  if (loading && !lib) {
    return (
      <div className="page library" aria-busy="true">
        <div className="spotlight skeleton" />
        <ul className="poster-grid skeleton" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <li key={i}>
              <span className="poster frame" />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const nothing = visible.length === 0 && pending.length === 0;

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
          <div className="toolbar">
            <div className="tabs" role="group" aria-label="Show">
              {TYPES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className="tab"
                  aria-pressed={type === x.id}
                  onClick={() => set("type", x.id === "all" ? null : x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <div className="tabs" role="group" aria-label="State">
              {STATES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className="tab"
                  aria-pressed={stateF === x.id}
                  onClick={() => set("state", x.id === "all" ? null : x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
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
              <option value="recent">Recently added</option>
              <option value="title">Title</option>
              <option value="year">Year</option>
            </select>
          </div>
        )}
      </div>

      {error && (
        <div className="banner" role="alert">
          <span>Can't load the Library: {error}.</span>
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
          {lib && lib.otherFiles > 0 ? (
            <>
              <h2>No films or shows yet</h2>
              <p>
                stash found {lib.otherFiles}{" "}
                {lib.otherFiles === 1 ? "video" : "videos"} that
                {lib.otherFiles === 1 ? " isn't" : " aren't"} a film or an
                episode.
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
          {!filtering && spotlight && <Spotlight t={spotlight} list={list} />}

          {!filtering && (inProgress.length > 0 || pending.length > 0) && (
            <Shelf id="shelf-downloading" heading="Downloading">
              {inProgress.map((t) => (
                <li key={t.key}>
                  <TitlePoster t={t} list={list} />
                </li>
              ))}
              {pending.map((tid) => (
                <li key={`p${tid}`}>
                  <Link
                    to="/transfers"
                    className="poster poster--pending"
                    data-rove-item
                    aria-label={`${nameOf(list, tid)}, fetching details`}
                  >
                    <span className="poster-art" aria-hidden="true">
                      <span className="poster-title poster-title--s">
                        {nameOf(list, tid)}
                      </span>
                      <span className="poster-foot">Fetching details…</span>
                    </span>
                  </Link>
                </li>
              ))}
            </Shelf>
          )}

          {!filtering && recent.length > 0 && (
            <Shelf id="shelf-recent" heading="Recently added">
              {recent.map((t) => (
                <li key={t.key}>
                  <TitlePoster t={t} list={list} />
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
                {q && (
                  <Link to={`/files?q=${encodeURIComponent(q)}`}>
                    Search files instead
                  </Link>
                )}
              </p>
            ) : (
              <ul className="poster-grid" data-rove="grid">
                {shown.map((t) => (
                  <li key={t.key}>
                    <TitlePoster t={t} list={list} />
                  </li>
                ))}
              </ul>
            )}
            {q && shown.length > 0 && (
              <p className="shelf-more">
                <Link to={`/files?q=${encodeURIComponent(q)}`}>
                  Search files for “{q}” →
                </Link>
              </p>
            )}
          </section>
        </>
      )}

      {(hidden.length > 0 || (lib?.otherFiles ?? 0) > 0) && !nothing && (
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
          {(lib?.otherFiles ?? 0) > 0 && (
            <Link className="btn btn--quiet btn--sm" to="/files">
              {lib?.otherFiles} other{" "}
              {lib?.otherFiles === 1 ? "video" : "videos"} in Files
            </Link>
          )}
        </footer>
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

function nameOf(list: Transfer[], tid: number): string {
  const t = list.find((x) => x.id === tid);
  return t?.name ?? "New transfer";
}

async function unhide(key: string) {
  await api.unhideTitle(key);
  await library.refresh();
}
