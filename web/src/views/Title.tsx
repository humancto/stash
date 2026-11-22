import { ArrowLeft, EyeOff, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from "react-router";
import { Status } from "../components/Status";
import { useRoom } from "../components/room";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { isTypingTarget } from "../lib/keys";
import {
  episodeLabel,
  episodeName,
  languageName,
  library,
  playChoice,
  qualityBadges,
  seasonsOf,
  statusOf,
  titleColor,
  useLibrary,
  type Title as TitleT,
  type TitleFile,
  type TransferIndex,
} from "../lib/library";

/** The file last played from a title page, so Back focuses its row. */
let lastPlayed: string | null = null;
const fileKey = (f: TitleFile) => `${f.tid}:${f.fid}`;

const watchState = (t: TitleT) => ({
  from: { path: `/title/${encodeURIComponent(t.key)}`, label: t.title },
});

function Badges({ f }: { f: TitleFile }) {
  const badges = qualityBadges(f.quality);
  if (badges.length === 0) return null;
  return (
    <span className="badges">
      {badges.map((b) => (
        <span key={b} className="badge">
          {b}
        </span>
      ))}
    </span>
  );
}

function FileRow({
  t,
  f,
  byId,
  label,
}: {
  t: TitleT;
  f: TitleFile;
  byId: TransferIndex;
  label: string;
}) {
  const status = statusOf(byId, f);
  const playable = status.kind === "ready" || status.kind === "streaming";
  const name = t.kind === "show" ? (episodeName(f.name) ?? f.name) : f.name;
  return (
    <li className="ep-row">
      <Link
        className="ep-main"
        to={`/watch/${f.tid}/${f.fid}`}
        state={watchState(t)}
        data-rove-item
        data-key={fileKey(f)}
        onClick={() => {
          lastPlayed = fileKey(f);
        }}
      >
        <span className="ep-label num">{label}</span>
        <span className="ep-name" dir="auto" title={f.name}>
          {name}
        </span>
        {!playable && (
          <span className="visually-hidden">, not playable yet</span>
        )}
      </Link>
      <Badges f={f} />
      <span className="ep-size num">{formatBytes(f.size)}</span>
      <Status status={status} />
    </li>
  );
}

const seasonName = (s: number | null) =>
  s === null ? "Other" : s === 0 ? "Specials" : `Season ${s}`;

export function Title() {
  const { key = "" } = useParams();
  const { library: lib, loading, error, byId } = useLibrary();
  const t = lib?.titles.find((x) => x.key === key) ?? null;
  const navigate = useNavigate();
  const navType = useNavigationType();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const room = useRoom();
  const color = t ? titleColor(t) : null;
  const seasons = useMemo(() => (t ? seasonsOf(t) : []), [t]);
  const wanted = params.get("season");
  const current =
    seasons.find((s) => (s === null ? "other" : String(s)) === wanted) ??
    seasons[0] ??
    null;
  const [hideError, setHideError] = useState<string | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const inApp = location.key !== "default";

  useEffect(() => {
    if (color) room.setScreen(color);
  }, [room, color]);

  // Arriving on a fresh page leaves focus on <body> (the poster unmounted):
  // put it on Play (or Hide). Back from the player focuses the played row.
  const ready = Boolean(t);
  // Once per arrival (PUSH or POP), never on our own REPLACEs (season).
  const arrived = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready || navType === "REPLACE" || arrived.current === location.key) return;
    arrived.current = location.key;
    if (navType === "POP" && lastPlayed) {
      const row = document.querySelector<HTMLElement>(
        `.ep-list [data-key="${CSS.escape(lastPlayed)}"]`,
      );
      if (row) {
        row.focus();
        return;
      }
    }
    actionsRef.current?.querySelector<HTMLElement>("[data-rove-item]")?.focus();
  }, [ready, key, navType, location.key]);

  // Its last file was deleted from the player: back to the Library.
  useEffect(() => {
    if (lib && !t && !error && inApp && navType === "POP")
      void navigate("/", { replace: true, state: { focusFirst: true } });
  }, [lib, t, error, inApp, navType, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== "Escape" ||
        e.defaultPrevented ||
        isTypingTarget(document.activeElement)
      )
        return;
      e.preventDefault();
      if (inApp) void navigate(-1);
      else void navigate("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, inApp]);

  if (loading && !lib) {
    return (
      <div className="page title-page" aria-busy="true">
        <div className="title-hero skeleton" />
      </div>
    );
  }
  if (error && !lib) {
    return (
      <div className="page">
        <div className="empty" role="alert">
          <h2>Can't load the Library</h2>
          <p>{error}.</p>
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
  if (!t) {
    return (
      <div className="page">
        <div className="empty">
          <h2>This title isn't in the Library</h2>
          <p>Its files may have been deleted, or the link is wrong.</p>
          <Link className="btn" to="/">
            Back to Library
          </Link>
        </div>
      </div>
    );
  }

  const play = playChoice(byId, t);
  const shownFile = play?.file ?? t.files[0];
  const langs =
    shownFile?.quality.languages
      .filter((l) => l !== "multi")
      .map(languageName) ?? [];
  const total = t.files.reduce((n, f) => n + f.size, 0);
  const files =
    t.kind === "show" ? t.files.filter((f) => f.season === current) : t.files;

  const pickSeason = (s: number | null) => {
    const next = new URLSearchParams(params);
    next.set("season", s === null ? "other" : String(s));
    setParams(next, { replace: true });
  };

  async function hide() {
    if (!t) return;
    setHideError(null);
    try {
      await api.hideTitle(t.key);
      await library.refresh();
      void navigate("/", { replace: true });
    } catch (e) {
      setHideError(e instanceof Error ? e.message : "Could not hide it.");
    }
  }

  return (
    <div className="page title-page">
      <Link
        className="back"
        to="/"
        onClick={(e) => {
          if (inApp) {
            e.preventDefault();
            void navigate(-1);
          }
        }}
      >
        <ArrowLeft aria-hidden="true" />
        Library
      </Link>
      <header
        className="title-hero"
        style={{ "--tc": color } as React.CSSProperties}
      >
        <div className="title-card" aria-hidden="true">
          <span className="poster-art">
            <span className="poster-title poster-title--l" dir="auto">
              {t.title}
            </span>
            <span className="poster-foot num">
              <span>{t.year ?? "Series"}</span>
              <span className="poster-detail">
                {t.kind === "film" ? "Film" : "Show"}
              </span>
            </span>
          </span>
        </div>
        <div className="title-text">
          <h1 className="title-name" dir="auto">
            {t.title}
          </h1>
          <p className="title-meta num">
            {[
              t.year,
              t.kind === "film" ? "Film" : "Show",
              t.kind === "show"
                ? `${t.files.length} ${t.files.length === 1 ? "episode" : "episodes"}`
                : t.files.length > 1
                  ? `${t.files.length} versions`
                  : null,
              formatBytes(total),
              ...langs,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {shownFile && t.kind === "film" && <Badges f={shownFile} />}
          <div className="title-actions" data-rove="grid" ref={actionsRef}>
            {play ? (
              <Link
                className="btn btn--primary"
                data-rove-item
                to={`/watch/${play.file.tid}/${play.file.fid}`}
                state={watchState(t)}
                onClick={() => {
                  lastPlayed = fileKey(play.file);
                }}
              >
                <Play aria-hidden="true" />
                {t.kind === "show"
                  ? `Play ${episodeLabel(play.file)}`
                  : play.streaming
                    ? "Play while downloading"
                    : "Play"}
              </Link>
            ) : (
              <span className="title-wait">
                Not playable yet. It starts once data arrives.
              </span>
            )}
            <button
              type="button"
              className="btn btn--quiet"
              data-rove-item
              onClick={() => void hide()}
            >
              <EyeOff aria-hidden="true" />
              Hide from Library
            </button>
          </div>
          {hideError && (
            <p className="add-error" role="alert">
              {hideError}
            </p>
          )}
        </div>
      </header>

      {t.kind === "show" && seasons.length > 1 && seasons.length <= 8 && (
        <div
          className="tabs season-tabs"
          role="group"
          aria-label="Season"
          data-rove="grid"
        >
          {seasons.map((s) => (
            <button
              key={s ?? "x"}
              type="button"
              className="tab"
              data-rove-item
              aria-pressed={s === current}
              onClick={() => pickSeason(s)}
            >
              {seasonName(s)}
            </button>
          ))}
        </div>
      )}
      {t.kind === "show" && seasons.length > 8 && (
        <div className="season-select">
          <label htmlFor="season">Season</label>
          <select
            id="season"
            className="select"
            value={current === null ? "other" : String(current)}
            onChange={(e) =>
              pickSeason(
                e.target.value === "other" ? null : Number(e.target.value),
              )
            }
          >
            {seasons.map((s) => (
              <option key={s ?? "x"} value={s === null ? "other" : String(s)}>
                {seasonName(s)}
              </option>
            ))}
          </select>
        </div>
      )}

      <section aria-labelledby="title-files">
        <h2 className="shelf-title" id="title-files">
          {t.kind === "film"
            ? t.files.length > 1
              ? "Versions"
              : "File"
            : current === null
              ? "Episodes"
              : seasonName(current)}
        </h2>
        <ul className="ep-list" data-rove>
          {files.map((f) => (
            <FileRow
              key={fileKey(f)}
              t={t}
              f={f}
              byId={byId}
              label={
                t.kind === "show"
                  ? episodeLabel(f)
                  : (qualityBadges(f.quality)[0] ?? "Play")
              }
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
