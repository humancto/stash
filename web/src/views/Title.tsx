import { ArrowLeft, EyeOff, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Status } from "../components/Status";
import { useRoom } from "../components/room";
import { api, type Transfer } from "../lib/api";
import { formatBytes } from "../lib/format";
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
} from "../lib/library";

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
  list,
  label,
}: {
  t: TitleT;
  f: TitleFile;
  list: Transfer[];
  label: string;
}) {
  const status = statusOf(list, f);
  const playable = status.kind === "ready" || status.kind === "streaming";
  return (
    <li className="ep-row">
      <Link
        className="ep-main"
        to={`/watch/${f.tid}/${f.fid}`}
        state={watchState(t)}
        data-rove-item
        aria-label={`${label}${playable ? "" : ", not playable yet"}`}
      >
        <span className="ep-label num">{label}</span>
        <span className="ep-name" dir="auto" title={f.name}>
          {t.kind === "show" ? (episodeName(f.name) ?? f.name) : f.name}
        </span>
      </Link>
      <Badges f={f} />
      <span className="ep-size num">{formatBytes(f.size)}</span>
      <Status status={status} />
    </li>
  );
}

export function Title() {
  const { key = "" } = useParams();
  const { library: lib, loading, transfers: list } = useLibrary();
  const t = lib?.titles.find((x) => x.key === key) ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const room = useRoom();
  const color = t ? titleColor(t) : null;
  const seasons = useMemo(() => (t ? seasonsOf(t) : []), [t]);
  const [season, setSeason] = useState<number | null | undefined>(undefined);
  const current = season === undefined ? (seasons[0] ?? null) : season;
  const [hideError, setHideError] = useState<string | null>(null);

  useEffect(() => {
    if (color) room.setScreen(color);
  }, [room, color]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)
        return;
      e.preventDefault();
      if (location.key === "default") void navigate("/");
      else void navigate(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, location.key]);

  if (loading && !lib) {
    return (
      <div className="page title-page" aria-busy="true">
        <div className="title-hero skeleton" />
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

  const play = playChoice(list, t);
  const first = t.files[0];
  const langs =
    first?.quality.languages.filter((l) => l !== "multi").map(languageName) ??
    [];
  const total = t.files.reduce((n, f) => n + f.size, 0);
  const shownFiles =
    t.kind === "show" ? t.files.filter((f) => f.season === current) : t.files;

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
          if (location.key !== "default") {
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
              <span className="poster-detail">{t.kind === "film" ? "Film" : "Show"}</span>
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
          {first && t.kind === "film" && <Badges f={first} />}
          <div className="title-actions" data-rove>
            {play ? (
              <Link
                className="btn btn--primary"
                data-rove-item
                to={`/watch/${play.file.tid}/${play.file.fid}`}
                state={watchState(t)}
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

      {t.kind === "show" && seasons.length > 1 && (
        <div className="tabs season-tabs" role="group" aria-label="Season">
          {seasons.map((s) => (
            <button
              key={s ?? "x"}
              type="button"
              className="tab"
              aria-pressed={s === current}
              onClick={() => setSeason(s)}
            >
              {s === null ? "Other" : s === 0 ? "Specials" : `Season ${s}`}
            </button>
          ))}
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
              : current === 0
                ? "Specials"
                : `Season ${current}`}
        </h2>
        <ul className="ep-list" data-rove>
          {shownFiles.map((f) => (
            <FileRow
              key={`${f.tid}:${f.fid}`}
              t={t}
              f={f}
              list={list}
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
