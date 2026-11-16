import { Download, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NetworkPanel } from "../components/NetworkStatus";
import { SignalPath } from "../components/SignalPath";
import { api, type KillLevel, type SeedingPolicy, type Settings } from "../lib/api";
import {
  DEFAULT_HOURS,
  DEFAULT_RATIO,
  describePolicy,
  draftFrom,
  minutesToHours,
  policyFromDraft,
  samePolicy,
  type SeedingDraft,
  type SeedingMode,
} from "../lib/seeding";
import {
  NETWORK_INTERVAL_MS,
  isStale,
  network,
  useNetwork,
} from "../lib/network";

const LEVEL_CHOICES: { id: KillLevel; title: string; text: string }[] = [
  {
    id: "strict",
    title: "Strict",
    text: "Without a VPN, no torrent traffic at all. Files already on disk still play.",
  },
  {
    id: "warn",
    title: "Warn",
    text: "Without a VPN, torrents keep running on your normal connection and peers see your real IP. stash shows a red warning.",
  },
  {
    id: "off",
    title: "Off",
    text: "Never tie torrents to a VPN. Use this when the VPN runs on your router.",
  },
];

const DEFAULT_LIST = "raw.githubusercontent.com/Naunter/BT_BlockLists";

function sourceName(url: string | null): string {
  if (!url) return "";
  if (url.includes(DEFAULT_LIST))
    return "Naunter BT_BlockLists (updated daily)";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function when(unix: number | null): string {
  if (!unix) return "never";
  const d = new Date(unix * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString()
    ? `today ${time}`
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** One settings request that gives up after `ms` or when `outer` aborts. */
async function settingsWithin(
  ms: number,
  outer: AbortSignal,
): Promise<Settings> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  outer.addEventListener("abort", onAbort);
  try {
    return await api.settings(ctrl.signal);
  } finally {
    clearTimeout(t);
    outer.removeEventListener("abort", onAbort);
  }
}

/** Waits for a *new* stash process: a different boot id, not restarting.
 * The old process can still answer for a moment after the 202. */
export async function waitForRestart(
  previousBoot: string,
  signal: AbortSignal,
  tries = 30,
): Promise<Settings | null> {
  await sleep(1500, signal);
  for (let i = 0; i < tries && !signal.aborted; i++) {
    try {
      const s = await settingsWithin(3000, signal);
      if (s.bootId !== previousBoot && !s.restartPending) return s;
    } catch {
      // Still restarting.
    }
    await sleep(1000, signal);
  }
  return null;
}

type Phase = "idle" | "saving" | "restarting" | "done" | "failed";

export function Privacy() {
  const net = useNetwork();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [level, setLevel] = useState<KillLevel | null>(null);
  const [blocklist, setBlocklist] = useState<boolean | null>(null);
  const [seedDraft, setSeedDraft] = useState<SeedingDraft | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const life = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const signal = life.current?.signal;
    try {
      const s = await api.settings(signal);
      if (signal?.aborted) return null;
      setSettings(s);
      setLoadError(null);
      setLevel((l) => l ?? s.vpn);
      setBlocklist((b) => b ?? s.blocklist);
      setSeedDraft((d) => d ?? draftFrom(s.seeding));
      return s;
    } catch (e) {
      if (!signal?.aborted)
        setLoadError(
          e instanceof Error ? e.message : "Could not load the settings.",
        );
      return null;
    }
  }, []);

  /** Waits for the restart, then checks what actually took effect. */
  const settle = useCallback(
    async (previousBoot: string, verify: (s: Settings) => string | null) => {
      const signal = life.current?.signal;
      if (!signal) return;
      setPhase("restarting");
      const s = await waitForRestart(previousBoot, signal);
      // The chip and panel must not keep "Restarting", even if we left.
      void network.refresh();
      if (signal.aborted) return;
      if (!s) {
        setPhase("failed");
        setMessage("stash didn't come back. Check the terminal it runs in.");
        return;
      }
      setSettings(s);
      setLevel(s.vpn);
      setBlocklist(s.blocklist);
      setSeedDraft(draftFrom(s.seeding));
      const problem = verify(s);
      setPhase(problem ? "failed" : "done");
      setMessage(problem ?? "Done. stash restarted with these settings.");
    },
    [],
  );

  useEffect(() => {
    life.current = new AbortController();
    void load().then((s) => {
      // Opened mid-restart: follow it instead of showing a normal page.
      if (s?.restartPending) void settle(s.bootId, () => null);
    });
    return () => life.current?.abort();
  }, [load, settle]);

  // While the list downloads, follow its progress.
  const fetching = settings?.blocklistStatus.fetching ?? false;
  useEffect(() => {
    if (!fetching) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [fetching, load]);

  const r =
    net.report && !isStale(net, NETWORK_INTERVAL_MS, Date.now())
      ? net.report
      : null;
  const blocked =
    r?.killSwitch?.state === "blocked" ||
    r?.killSwitch?.state === "reconnecting";
  const vpnLocked = settings?.vpnFrom === "env";
  const listLocked = settings?.blocklistFrom === "env";
  const seedLocked = settings?.seedingFrom === "env";
  const vpnDirty = settings !== null && level !== null && level !== settings.vpn && !vpnLocked;
  const listDirty =
    settings !== null && blocklist !== null && blocklist !== settings.blocklist && !listLocked;
  const seedResult = seedDraft ? policyFromDraft(seedDraft) : null;
  const seedDirty =
    settings !== null &&
    seedDraft !== null &&
    !seedLocked &&
    (!seedResult?.ok || !samePolicy(seedResult.policy, settings.seeding));
  const seedInvalid = seedDirty && seedResult !== null && !seedResult.ok;
  const changed = vpnDirty || listDirty || seedDirty;
  const needsRestart = vpnDirty || listDirty;
  const busy = phase === "saving" || phase === "restarting";

  async function save() {
    if (!settings || !changed || busy || seedInvalid) return;
    const update: {
      vpn?: KillLevel;
      blocklist?: boolean;
      seeding?: SeedingPolicy;
    } = {};
    if (vpnDirty && level !== null) update.vpn = level;
    if (listDirty && blocklist !== null) update.blocklist = blocklist;
    // Env-locked seeding is never sent (the server would refuse the lot).
    if (seedDirty && seedResult?.ok) update.seeding = seedResult.policy;
    setPhase("saving");
    setMessage("");
    let restart: boolean;
    try {
      ({ restart } = await api.saveSettings(update));
    } catch (e) {
      setPhase("failed");
      setMessage(
        e instanceof Error ? e.message : "Could not save the settings.",
      );
      return;
    }
    if (!restart) {
      // Seeding only: applied already, no restart.
      const s = await load();
      if (s) {
        setSeedDraft(draftFrom(s.seeding));
      } else if (update.seeding) {
        // Saved, but the reload failed: show what was sent, not stale data.
        const sent = update.seeding;
        setSettings((prev) => (prev ? { ...prev, seeding: sent, seedingFrom: "file" } : prev));
        setPhase("done");
        setMessage("Saved. Couldn't reload the settings to confirm.");
        return;
      }
      setPhase("done");
      setMessage(
        update.seeding?.mode === "stop"
          ? "Saved. Finished transfers stop seeding within a few seconds."
          : "Saved. It applies now.",
      );
      return;
    }
    await settle(settings.bootId, (s) =>
      (update.vpn !== undefined && s.vpn !== update.vpn) ||
      (update.blocklist !== undefined && s.blocklist !== update.blocklist) ||
      (update.seeding !== undefined && !samePolicy(s.seeding, update.seeding))
        ? "stash restarted, but the new settings didn't take effect."
        : null,
    );
  }

  async function restartToApply() {
    if (!settings || busy) return;
    setPhase("saving");
    setMessage("");
    try {
      await api.restart();
    } catch (e) {
      setPhase("failed");
      setMessage(e instanceof Error ? e.message : "Could not restart stash.");
      return;
    }
    await settle(settings.bootId, (s) =>
      s.blocklistStatus.inUse
        ? null
        : "stash restarted, but the blocklist isn't in use. See the blocklist status above.",
    );
  }

  async function updateList() {
    try {
      await api.refreshBlocklist();
      if (phase === "failed") {
        setPhase("idle");
        setMessage("");
      }
      await load();
    } catch (e) {
      setPhase("failed");
      setMessage(e instanceof Error ? e.message : "Could not update the list.");
    }
  }

  const st = settings?.blocklistStatus;

  return (
    <div className="page privacy">
      <div className="page-head">
        <div>
          <h1 className="page-title">Privacy</h1>
          <p className="page-sub">
            What torrent peers can see, and what stash does about it.
          </p>
        </div>
      </div>

      {r && <SignalPath report={r} />}
      <NetworkPanel />

      {loadError && (
        <div className="banner" role="alert">
          <span>
            Couldn't load the settings: {loadError.replace(/\.$/, "")}.
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}

      {!settings && !loadError && (
        <p className="settings-loading" role="status">
          Loading settings…
        </p>
      )}

      {settings && (
        <form
          className="settings"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset
            className="setting"
            aria-describedby={vpnLocked ? "vpn-help vpn-lock" : "vpn-help"}
          >
            <legend className="setting-title">Kill switch</legend>
            <p className="setting-text" id="vpn-help">
              stash finds your VPN by itself, even when it reconnects with a new
              tunnel. This decides what happens when there is no VPN.
            </p>
            {vpnLocked && (
              <p className="setting-lock" id="vpn-lock">
                Set by <code>STASH_VPN</code>
                {settings.vpnInterface
                  ? ` (only ${settings.vpnInterface} counts as the VPN)`
                  : ""}
                . Change it there.
              </p>
            )}
            <div className="choices">
              {LEVEL_CHOICES.map((l) => (
                <label
                  key={l.id}
                  className="choice"
                  data-locked={vpnLocked || busy || undefined}
                >
                  <input
                    type="radio"
                    name="vpn"
                    value={l.id}
                    checked={level === l.id}
                    // Locked radios stay focusable so the value and the reason
                    // can be reached; changes are refused instead.
                    aria-disabled={vpnLocked || busy || undefined}
                    onChange={() => {
                      if (!vpnLocked && !busy) setLevel(l.id);
                    }}
                  />
                  <span className="choice-body">
                    <span className="choice-title">
                      {l.title}
                      {l.id === "strict" && (
                        <span className="choice-tag">Recommended</span>
                      )}
                    </span>
                    <span className="choice-text">{l.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="setting">
            <legend className="setting-title">Blocklist</legend>
            <div className="setting-row">
              <p className="setting-text" id="list-help">
                Refuse peers from IP ranges known for monitoring and anti-P2P
                work. A filter, not a shield: monitors change addresses.
              </p>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={blocklist ?? false}
                aria-label="Use the blocklist"
                aria-describedby={
                  listLocked ? "list-help list-lock" : "list-help"
                }
                aria-disabled={listLocked || busy || undefined}
                onClick={() => {
                  if (!listLocked && !busy) setBlocklist((b) => !b);
                }}
              >
                <span className="switch-knob" />
              </button>
            </div>
            {listLocked && (
              <p className="setting-lock" id="list-lock">
                Set by <code>STASH_BLOCKLIST</code>. Change it there.
              </p>
            )}
            {settings.blocklist && st && (
              <div className="list-status">
                <p className="num">
                  {st.ranges !== null
                    ? `${st.ranges.toLocaleString()} ranges`
                    : "Not downloaded yet"}
                  {st.updatedAt !== null && ` · updated ${when(st.updatedAt)}`}
                  {settings.blocklistSource &&
                    ` · ${sourceName(settings.blocklistSource)}`}
                </p>
                <p
                  className={st.inUse ? "status--ready" : "net-dim"}
                  role="status"
                >
                  {st.fetching
                    ? "Downloading…"
                    : st.inUse
                      ? "In use"
                      : st.ranges !== null
                        ? "Downloaded. It applies after a restart."
                        : "Waiting to download."}
                </p>
                {blocked && !st.fetching && (
                  <p className="net-dim" id="list-blocked">
                    No VPN right now, so stash won't download the list. It
                    updates once a VPN is connected.
                  </p>
                )}
                {st.error && (
                  <p className="status--error">
                    {st.error.replace(/\.$/, "")}.
                  </p>
                )}
                <div className="list-actions">
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    disabled={st.fetching || blocked || busy}
                    aria-describedby={blocked ? "list-blocked" : undefined}
                    onClick={() => void updateList()}
                  >
                    <Download aria-hidden="true" />
                    Update now
                  </button>
                  {!st.inUse && st.ranges !== null && !st.fetching && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      aria-disabled={changed || busy || undefined}
                      title={changed ? "Save your changes first" : undefined}
                      onClick={() => {
                        if (!changed) void restartToApply();
                      }}
                    >
                      <RotateCw aria-hidden="true" />
                      Restart to apply
                    </button>
                  )}
                </div>
              </div>
            )}
          </fieldset>

          {seedDraft && (
            <SeedingSection
              draft={seedDraft}
              setDraft={setSeedDraft}
              locked={seedLocked}
              lockedPolicy={settings.seeding}
              busy={busy}
              error={seedInvalid && seedResult && !seedResult.ok ? seedResult : null}
            />
          )}

          <section className="setting" aria-labelledby="conn-title">
            <h2 id="conn-title" className="setting-title">
              Connections
            </h2>
            <dl className="facts">
              <div>
                <dt>Incoming peers</dt>
                <dd>
                  {settings.listenPort !== null ? (
                    <span className="num">
                      Port {settings.listenPort}, TCP and uTP
                    </span>
                  ) : (
                    <>
                      Off. Set <code>STASH_LISTEN_PORT</code> to accept them;
                      with a VPN, use the port it forwards.
                    </>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <div className="settings-bar">
            <p className="settings-msg" role="status">
              {phase === "saving"
                ? "Saving…"
                : phase === "restarting"
                  ? "Applying. stash restarts in a moment…"
                  : phase === "done"
                    ? message
                    : ""}
            </p>
            <p className="settings-msg status--error" role="alert">
              {phase === "failed" ? message : ""}
            </p>
            <button
              type="submit"
              className="btn btn--primary"
              // aria-disabled keeps focus on the button while it applies.
              aria-disabled={!changed || busy || seedInvalid || undefined}
            >
              {busy
                ? needsRestart || phase === "restarting"
                  ? "Applying…"
                  : "Saving…"
                : needsRestart
                  ? "Save and restart"
                  : "Save"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const SEED_CHOICES: { id: SeedingMode; title: string; text: string }[] = [
  {
    id: "stop",
    title: "Stop when finished",
    text: "Stop sharing once a download finishes. Peers still get pieces from you while it downloads; that's how BitTorrent works.",
  },
  {
    id: "ratio",
    title: "Until a ratio",
    text: "Keep sharing until it has uploaded a multiple of its size.",
  },
  {
    id: "time",
    title: "For a while",
    text: "Keep sharing for a number of hours after it finishes.",
  },
  {
    id: "forever",
    title: "Keep seeding",
    text: "Share until you pause or delete it.",
  },
];

function SeedingSection({
  draft,
  setDraft,
  locked,
  lockedPolicy,
  busy,
  error,
}: {
  draft: SeedingDraft;
  setDraft: (d: SeedingDraft) => void;
  locked: boolean;
  lockedPolicy: SeedingPolicy;
  busy: boolean;
  error: { field: "ratio" | "hours"; error: string } | null;
}) {
  const off = locked || busy;
  const set = (next: Partial<SeedingDraft>) => {
    if (!off) setDraft({ ...draft, ...next });
  };
  // An env value that doesn't fit the hours field is shown as text.
  const lockedText =
    locked &&
    lockedPolicy.mode === "time" &&
    minutesToHours(lockedPolicy.minutes) === null
      ? describePolicy(lockedPolicy)
      : null;
  return (
    <fieldset
      className="setting"
      aria-describedby={locked ? "seed-help seed-lock" : "seed-help"}
    >
      <legend className="setting-title">Seeding</legend>
      <p className="setting-text" id="seed-help">
        Seeding helps others finish their downloads, and keeps your address
        visible to peers for longer.
      </p>
      {locked && (
        <p className="setting-lock" id="seed-lock">
          Set by <code>STASH_SEEDING</code>
          {lockedText ? ` (${lockedText})` : ""}. Change it there.
        </p>
      )}
      <div className="choices choices--four">
        {SEED_CHOICES.map((c) => (
          <div key={c.id} className="choice-wrap">
            <label className="choice" data-locked={off || undefined}>
              <input
                type="radio"
                name="seeding"
                value={c.id}
                checked={draft.mode === c.id}
                aria-disabled={off || undefined}
                onChange={() => set({ mode: c.id })}
              />
              <span className="choice-body">
                <span className="choice-title">
                  {c.title}
                  {c.id === "stop" && (
                    <span className="choice-tag">Recommended</span>
                  )}
                </span>
                <span className="choice-text">{c.text}</span>
              </span>
            </label>
            {c.id === "ratio" && (
              <NumberField
                id="seed-ratio"
                label="Ratio"
                unit="× its size"
                value={draft.ratio}
                placeholder={DEFAULT_RATIO}
                locked={off}
                error={error?.field === "ratio" ? error.error : null}
                onChange={(ratio) => set({ ratio, mode: "ratio" })}
              />
            )}
            {c.id === "time" && (
              <NumberField
                id="seed-hours"
                label="Hours"
                unit="after it finishes"
                value={draft.hours}
                placeholder={DEFAULT_HOURS}
                locked={off}
                error={error?.field === "hours" ? error.error : null}
                onChange={(hours) => set({ hours, mode: "time" })}
              />
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  unit,
  value,
  placeholder,
  locked,
  error,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  placeholder: string;
  locked: boolean;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const describedBy = [`${id}-unit`, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="choice-field">
      <label htmlFor={id} className="choice-field-label">
        {label}
      </label>
      <input
        id={id}
        className="input input--sm num"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        readOnly={locked}
        aria-disabled={locked || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={`${id}-unit`} className="choice-field-unit">
        {unit}
      </span>
      {error && (
        <p id={`${id}-error`} className="choice-field-error status--error">
          {error}
        </p>
      )}
    </div>
  );
}
