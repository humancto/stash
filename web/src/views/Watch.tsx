import {
  ArrowDownToLine,
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  ListVideo,
  Pause,
  Play,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ConfirmDelete } from "../components/ConfirmDelete";
import { useWritesPaused } from "../components/NetworkStatus";
import { useRoom } from "../components/room";
import { Status, statusText } from "../components/Status";
import { api, streamPath } from "../lib/api";
import { copyText, downloadText } from "../lib/clipboard";
import {
  extension,
  fileStatus,
  isDeleted,
  isNativelyPlayable,
  isPlayable,
  kindOf,
  shownFiles,
} from "../lib/files";
import { formatBytes } from "../lib/format";
import { isTypingTarget } from "../lib/keys";
import { absoluteUrl, averageColor, m3u, vlcUrl } from "../lib/media";
import { transfers, useTransfers } from "../lib/store";

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Samples the playing video's frame and lights the room with its colour. */
function useAmbientLight(video: HTMLMediaElement | null) {
  const room = useRoom();

  // The room keeps the light of the last film it showed (or the booth's
  // tungsten when none has played); only real frames change it.
  useEffect(() => {
    room.setWatching(true);
    return () => room.setWatching(false);
  }, [room]);

  useEffect(() => {
    if (!(video instanceof HTMLVideoElement)) return;
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 9;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const sample = () => {
      if (video.paused || video.readyState < 2 || document.hidden) return;
      try {
        ctx.drawImage(video, 0, 0, 16, 9);
        const rgb = averageColor(ctx.getImageData(0, 0, 16, 9).data);
        if (rgb) room.setScreen(`rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`);
      } catch {
        // A tainted or undecodable frame: keep the current light.
      }
    };
    const start = () => {
      if (timer) return;
      sample();
      timer = setInterval(sample, reducedMotion() ? 2000 : 500);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    video.addEventListener("playing", start);
    video.addEventListener("pause", stop);
    video.addEventListener("ended", stop);
    if (!video.paused) start();
    return () => {
      stop();
      video.removeEventListener("playing", start);
      video.removeEventListener("pause", stop);
      video.removeEventListener("ended", stop);
    };
  }, [video, room]);
}

export function Watch() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tid = Number(params["tid"]);
  const fid = Number(params["fid"]);
  const { transfers: list, loading, error } = useTransfers();
  const [video, setVideo] = useState<HTMLMediaElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const writesPaused = useWritesPaused();

  const t = list.find((x) => x.id === tid);
  const file = Number.isInteger(fid) ? t?.files?.[fid] : undefined;
  const name = file
    ? (file.components[file.components.length - 1] ?? file.name)
    : "";
  useAmbientLight(video);

  useEffect(() => {
    if (!video) return;
    const sync = () => setPlaying(!video.paused);
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    video.addEventListener("ended", sync);
    return () => {
      video.removeEventListener("play", sync);
      video.removeEventListener("pause", sync);
      video.removeEventListener("ended", sync);
    };
  }, [video]);

  useEffect(() => setFailed(false), [tid, fid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== "Escape" ||
        e.defaultPrevented ||
        document.fullscreenElement ||
        isTypingTarget(document.activeElement)
      )
        return;
      e.preventDefault();
      // A deep link has no in-app history to go back to.
      if (location.key === "default") navigate("/files");
      else navigate(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, location.key]);

  if (loading) {
    return (
      <div className="watch skeleton" aria-busy="true">
        <div>
          <div className="screen" />
          <div
            className="bar"
            style={{ width: "40%", marginTop: 24, height: 18 }}
          />
        </div>
      </div>
    );
  }

  if (!t || !file) {
    if (error && list.length === 0) {
      return (
        <div className="page">
          <div className="empty" role="alert">
            <h2>Can't reach stash</h2>
            <p>{error}. It will keep retrying.</p>
            <button type="button" className="btn" onClick={() => void transfers.refresh()}>
              Retry now
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="page">
        <div className="empty">
          <h2>This file isn't here</h2>
          <p>It may have been deleted, or the link is wrong.</p>
          <Link className="btn" to="/files">
            Back to Files
          </Link>
        </div>
      </div>
    );
  }

  if (isDeleted(t, fid)) {
    // No player or links: the server answers 410 for a deleted file.
    return (
      <div className="page">
        <div className="empty">
          <h2>This file was deleted</h2>
          <p>
            “{name}” was removed from disk and won't be downloaded again. The
            rest of “{t.name ?? "the transfer"}” is still here.
          </p>
          <Link className="btn" to="/files">
            Back to Files
          </Link>
        </div>
      </div>
    );
  }

  const sole = shownFiles(t).length <= 1;
  const src = streamPath(tid, fid);
  const url = absoluteUrl(src);
  const status = fileStatus(t, fid, file);
  const playable = isPlayable(name) && file.included;
  const ext = extension(name);

  async function copy(what: string, text: string) {
    const ok = await copyText(text);
    setCopied(ok ? what : `Copy this link: ${text}`);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 4000);
  }

  return (
    <div className="watch">
      <div style={{ minWidth: 0 }}>
        <Link className="back" to="/files">
          <ArrowLeft aria-hidden="true" />
          Files
        </Link>
        <div className="screen">
          {playable && !failed ? (
            kindOf(name) === "audio" ? (
              <div className="screen-note">
                <audio
                  ref={setVideo}
                  src={src}
                  controls
                  preload="metadata"
                  onError={() => setFailed(true)}
                />
              </div>
            ) : (
              <video
                ref={setVideo}
                src={src}
                controls
                playsInline
                preload="metadata"
                onError={() => setFailed(true)}
              />
            )
          ) : (
            <div className="screen-note">
              <strong>
                {playable
                  ? "This browser can't play this file yet"
                  : "Not a video"}
              </strong>
              <p>
                {playable
                  ? `${ext.toUpperCase()} files ${isNativelyPlayable(name) ? "with this codec " : ""}need a player like VLC for now. Download it, or open the stream in VLC.`
                  : "Download it to open it on this device."}
              </p>
            </div>
          )}
        </div>
        <h1 className="watch-title">{name}</h1>
        <div className="watch-meta num">
          <Status status={status} />
          <span>{formatBytes(file.length)}</span>
          {ext && <span>{ext.toUpperCase()}</span>}
          <span title={t.name ?? undefined}>From {t.name ?? "a transfer"}</span>
        </div>
      </div>

      <aside className="side" aria-label="Actions" data-zone data-rove>
        {playable && !failed && (
          <button
            type="button"
            className="btn btn--primary"
            data-rove-item
            onClick={() => {
              if (!video) return;
              if (video.paused) void video.play();
              else video.pause();
            }}
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {playing ? "Pause" : "Play"}
          </button>
        )}
        <a
          className="btn"
          href={`${src}?download=1`}
          download={name}
          data-rove-item
        >
          <Download aria-hidden="true" />
          <span>
            Download<span className="btn-extra num"> · {formatBytes(file.length)}</span>
          </span>
        </a>
        <button
          type="button"
          className="btn"
          data-rove-item
          onClick={() => void copy("Stream link copied", url)}
        >
          <Copy aria-hidden="true" />
          Copy stream link
        </button>
        {playable && (
          <>
            <a className="btn" href={vlcUrl(url)} data-rove-item>
              <ExternalLink aria-hidden="true" />
              Open in VLC
            </a>
            <button
              type="button"
              className="btn"
              data-rove-item
              onClick={() =>
                downloadText(`${name}.m3u`, m3u(name, url), "audio/x-mpegurl")
              }
            >
              <ListVideo aria-hidden="true" />
              VLC / IINA playlist
            </button>
          </>
        )}
        {copied && (
          <p
            className="copied"
            role="status"
            style={{ overflowWrap: "anywhere" }}
          >
            {copied}
          </p>
        )}
        <p className="side-note">
          {status.kind === "ready"
            ? "Fully downloaded."
            : `${statusText(status)}. Playback fetches what it needs first.`}
        </p>
        <div className="side-gap" />
        <Link className="btn btn--quiet side-transfer" to="/transfers" data-rove-item>
          <ArrowDownToLine aria-hidden="true" />
          Go to transfer
        </Link>
        {!sole && (
          <ConfirmDelete
            what={`“${name}”`}
            label="Delete file"
            prompt={`Delete “${name}” from disk? stash won't download it again.`}
            pausedReason={writesPaused ?? undefined}
            rove
            onConfirm={async () => {
              await api.removeFile(tid, fid);
              // Leave first: the next list would show this page's
              // "deleted" state for a frame. Files aims focus past this row.
              navigate("/files", {
                replace: true,
                state: { focusList: true, deletedKey: `${tid}:${fid}` },
              });
              void transfers.refresh();
            }}
          />
        )}
        <ConfirmDelete
          what={`the whole transfer “${t.name ?? name}”`}
          label="Delete transfer"
          pausedReason={writesPaused ?? undefined}
          rove
          onConfirm={async () => {
            await transfers.mutate(() => api.remove(tid));
            navigate("/files", { replace: true, state: { focusList: true } });
          }}
        />
      </aside>
    </div>
  );
}
