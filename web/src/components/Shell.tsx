import { ArrowDownToLine, Clapperboard, Library as LibraryIcon, Plus, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { adder, useAdder } from "../lib/adder";
import { useAddAndGo } from "../lib/useAddAndGo";
import { handleNavKey, isTypingTarget } from "../lib/keys";
import { isTorrentFile, isTorrentLink } from "../lib/magnet";
import { transfers, useTransfers } from "../lib/store";
import { network } from "../lib/network";
import { Logo } from "./Logo";
import { NetworkChip, useWritesPaused } from "./NetworkStatus";
import { RoomContext, type Room } from "./room";

function NavLinks({ active }: { active: number }) {
  return (
    <>
      <NavLink to="/" end className="nav-link" data-rove-item>
        <LibraryIcon aria-hidden="true" />
        <span>Library</span>
      </NavLink>
      <NavLink to="/files" className="nav-link" data-rove-item>
        <Clapperboard aria-hidden="true" />
        <span>Files</span>
      </NavLink>
      <NavLink to="/transfers" className="nav-link" data-rove-item>
        <ArrowDownToLine aria-hidden="true" />
        <span>Transfers</span>
        {active > 0 && (
          <span className="nav-count num" aria-label={`${active} active`}>
            {active}
          </span>
        )}
      </NavLink>
      <NavLink to="/privacy" className="nav-link" data-rove-item>
        <ShieldCheck aria-hidden="true" />
        <span>Privacy</span>
      </NavLink>
    </>
  );
}

function AddMagnet() {
  const [url, setUrl] = useState("");
  const { busy, error, status } = useAdder();
  const writesPaused = useWritesPaused();
  const addAndGo = useAddAndGo();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) document.getElementById("add-url")?.focus();
    if (await addAndGo({ kind: "url", url })) setUrl("");
  }

  return (
    <form className="add" onSubmit={(e) => void submit(e)}>
      <label className="visually-hidden" htmlFor="add-url">
        Magnet link or .torrent URL
      </label>
      <input
        id="add-url"
        className="input"
        placeholder="Paste a magnet link or .torrent URL"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          adder.clear();
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="btn btn--primary"
        disabled={busy}
        aria-disabled={writesPaused ? true : undefined}
        title={writesPaused ?? undefined}
      >
        <Plus aria-hidden="true" />
        {busy ? "Adding…" : "Add"}
      </button>
      {error && (
        <p className="add-error" role="alert">
          {error}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {status ?? ""}
      </p>
    </form>
  );
}

/** Paste a magnet, info hash, .torrent URL or .torrent file anywhere that
 * isn't a text field. */
function usePasteToAdd() {
  const addAndGo = useAddAndGo();
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(document.activeElement)) return;
      const data = e.clipboardData;
      if (!data) return;
      const files = [...data.files];
      if (files.length > 0) {
        if (!files.some(isTorrentFile)) return;
        e.preventDefault();
        void addAndGo({ kind: "files", files });
        return;
      }
      const text = data.getData("text/plain").trim();
      if (!isTorrentLink(text)) return;
      e.preventDefault();
      void addAndGo({ kind: "url", url: text });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addAndGo]);
}

/** Drop .torrent files, or a magnet/.torrent link from another app or tab. */
function DropToAdd() {
  const [over, setOver] = useState(false);
  const addAndGo = useAddAndGo();
  useEffect(() => {
    let internal = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      setOver(false);
    };
    const droppable = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      return !internal && (types.includes("Files") || types.includes("text/uri-list"));
    };
    const onDragStart = () => {
      internal = true;
    };
    const onDragEnd = () => {
      internal = false;
    };
    const onBlur = () => {
      internal = false;
      hide();
    };
    const onDragOver = (e: DragEvent) => {
      if (!droppable(e)) return;
      // Always: otherwise the browser opens the dropped file in this tab.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setOver(true);
      if (timer) clearTimeout(timer);
      // dragover repeats (every 350 ± 200 ms when still) while over the
      // page; a long silence means the drag left without a dragleave.
      timer = setTimeout(hide, 1000);
    };
    const onDrop = (e: DragEvent) => {
      const wasInternal = internal;
      // dragend may never reach document (its source was removed): reset
      // here so a later file drop is never left to the browser.
      internal = false;
      if (wasInternal) return;
      if (!droppable(e)) return;
      e.preventDefault();
      hide();
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = [...dt.files];
      if (files.length > 0) {
        void addAndGo({ kind: "files", files });
        return;
      }
      const link = (dt.getData("text/uri-list") || dt.getData("text/plain"))
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      if (link && isTorrentLink(link)) void addAndGo({ kind: "url", url: link });
      else adder.fail("Only .torrent files and magnet links can be dropped here.");
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    window.addEventListener("dragenter", onDragOver);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("blur", onBlur);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("dragenter", onDragOver);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", onBlur);
    };
  }, [addAndGo]);
  if (!over) return null;
  return (
    <div
      className="drop-overlay"
      aria-hidden="true"
      data-testid="drop-overlay"
      onDragLeave={(e) => {
        // Left the window (children ignore pointer events, so this only
        // fires for the overlay itself).
        if (e.relatedTarget === null) setOver(false);
      }}
    >
      <div className="drop-card">
        <ArrowDownToLine />
        <p>Drop to add</p>
        <span>.torrent files or magnet links</span>
      </div>
    </div>
  );
}

function SearchBox({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // Files searches files; everywhere else searches the Library (home).
  const target = location.pathname === "/files" ? "/files" : "/";
  const here = location.pathname === target;
  const q = here ? (params.get("q") ?? "") : "";
  const what = target === "/files" ? "files" : "library";

  return (
    <div className="search" role="search">
      <Search aria-hidden="true" />
      <label className="visually-hidden" htmlFor="search">
        Search {what}
      </label>
      <input
        ref={inputRef}
        id="search"
        className="input"
        type="search"
        placeholder={`Search ${what}`}
        value={q}
        autoComplete="off"
        onChange={(e) => {
          const next = new URLSearchParams(here ? params : undefined);
          if (e.target.value) next.set("q", e.target.value);
          else next.delete("q");
          const qs = next.toString();
          void navigate(`${target}${qs ? `?${qs}` : ""}`, { replace: here });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <kbd className="kbd" aria-hidden="true">
        /
      </kbd>
    </div>
  );
}

export function Shell() {
  const roomRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [watching, setWatching] = useState(false);
  const { transfers: list } = useTransfers();
  const active = list.filter((t) => t.stats?.state === "live" && !t.stats.finished).length;

  useEffect(() => {
    const stop = transfers.start();
    const stopNetwork = network.start();
    const onVis = () => {
      transfers.visibilityChanged();
      network.visibilityChanged();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      stopNetwork();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleNavKey(e, () => searchRef.current?.focus());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const setScreen = useCallback((color: string | null) => {
    const el = roomRef.current;
    if (!el) return;
    if (color) el.style.setProperty("--screen", color);
    else el.style.removeProperty("--screen");
  }, []);
  const room: Room = useMemo(() => ({ setScreen, setWatching }), [setScreen]);
  usePasteToAdd();

  return (
    <RoomContext.Provider value={room}>
      <div className="room" ref={roomRef} data-watching={watching}>
        <nav className="rail" aria-label="Main" data-zone data-rove>
          <NavLink to="/" className="wordmark" tabIndex={-1}>
            <Logo />
            <span>stash</span>
          </NavLink>
          <NavLinks active={active} />
          <div className="rail-foot">
            <NetworkChip />
          </div>
        </nav>
        <div className="main">
          <header className="topbar">
            <SearchBox inputRef={searchRef} />
            <AddMagnet />
          </header>
          <main data-zone>
            <Outlet />
          </main>
        </div>
        <DropToAdd />
        <nav className="tabbar" aria-label="Sections">
          <NavLinks active={active} />
        </nav>
      </div>
    </RoomContext.Provider>
  );
}
