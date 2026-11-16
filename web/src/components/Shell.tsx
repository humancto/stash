import { ArrowDownToLine, Clapperboard, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { handleNavKey } from "../lib/keys";
import { transfers, useTransfers } from "../lib/store";
import { network } from "../lib/network";
import { Logo } from "./Logo";
import { NetworkChip } from "./NetworkStatus";
import { RoomContext, type Room } from "./room";

function NavLinks({ active }: { active: number }) {
  return (
    <>
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
    </>
  );
}

function AddMagnet() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!value) {
      setError("Paste a magnet link or a .torrent URL first.");
      document.getElementById("add-url")?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await transfers.mutate(() => api.add(value));
      setUrl("");
      navigate("/transfers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add" onSubmit={submit}>
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
          if (error) setError(null);
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <button className="btn btn--primary" disabled={busy}>
        <Plus aria-hidden="true" />
        {busy ? "Adding…" : "Add"}
      </button>
      {error && (
        <p className="add-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function SearchBox({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.pathname === "/files" ? (params.get("q") ?? "") : "";

  return (
    <div className="search" role="search">
      <Search aria-hidden="true" />
      <label className="visually-hidden" htmlFor="search">
        Search files
      </label>
      <input
        ref={inputRef}
        id="search"
        className="input"
        type="search"
        placeholder="Search files"
        value={q}
        autoComplete="off"
        onChange={(e) => {
          const next = new URLSearchParams(location.pathname === "/files" ? params : undefined);
          if (e.target.value) next.set("q", e.target.value);
          else next.delete("q");
          const qs = next.toString();
          navigate(`/files${qs ? `?${qs}` : ""}`, { replace: location.pathname === "/files" });
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

  return (
    <RoomContext.Provider value={room}>
      <div className="room" ref={roomRef} data-watching={watching}>
        <nav className="rail" aria-label="Main" data-zone data-rove>
          <NavLink to="/files" className="wordmark" tabIndex={-1}>
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
        <nav className="tabbar" aria-label="Sections">
          <NavLinks active={active} />
        </nav>
      </div>
    </RoomContext.Provider>
  );
}
