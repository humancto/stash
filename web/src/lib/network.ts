// Shared poller for /api/network: what torrent peers can see. Started and
// stopped explicitly by Shell (StrictMode-safe), like the transfer store.
// The server asks Cloudflare for the public IP, so this polls slowly.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type NetworkReport } from "./api";

export interface NetworkSnapshot {
  report: NetworkReport | null;
  /** Message of the last failed check; the report is kept from the last success. */
  error: string | null;
  /** True until the first check finishes. */
  loading: boolean;
  /** A user-pressed "Check again" is in flight. */
  refreshing: boolean;
  /** Browser clock (ms) when the report arrived. Age is judged from this,
   * not the server's checked_at, so clock skew can't make it look fresh. */
  receivedAt: number | null;
}

export interface NetworkDeps {
  fetchReport: (opts: {
    refresh: boolean;
    signal: AbortSignal;
  }) => Promise<NetworkReport>;
  intervalMs: number;
  isHidden: () => boolean;
  now: () => number;
  /** A check that takes longer is aborted and counts as failed. */
  timeoutMs?: number;
}

/** A report nobody should trust: the last check failed, or it is too old.
 * A stale "tunnel" must never keep showing as a VPN. */
export function isStale(
  s: NetworkSnapshot,
  intervalMs: number,
  now: number,
): boolean {
  if (!s.report) return false;
  return (
    s.error !== null ||
    s.receivedAt === null ||
    now - s.receivedAt > 2 * intervalMs
  );
}

export function createNetworkStore(deps: NetworkDeps) {
  let snapshot: NetworkSnapshot = {
    report: null,
    error: null,
    loading: true,
    refreshing: false,
    receivedAt: null,
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let seq = 0;
  let lastDone = -Infinity; // deps.now() of the last finished check
  let running = false;

  const emit = (next: NetworkSnapshot) => {
    snapshot = next;
    for (const l of listeners) l();
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delay = deps.intervalMs) => {
    clear();
    if (running && !deps.isHidden())
      timer = setTimeout(() => void check(false), delay);
  };

  /** While stash is restarting, check again soon so "Reconnecting" and
   * the paused-actions notice don't outlive the restart by minutes. */
  const settling = () => {
    const ks = snapshot.report?.killSwitch;
    return (
      ks !== null &&
      ks !== undefined &&
      ks.state !== "restart_failed" &&
      (ks.state === "reconnecting" || !ks.acceptingWrites)
    );
  };

  async function check(refresh: boolean): Promise<void> {
    clear();
    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    const id = ++seq;
    if (refresh) emit({ ...snapshot, refreshing: true });
    // A hung request (e.g. a half-dead tunnel after sleep) must not stop polling.
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, deps.timeoutMs ?? 10_000);
    try {
      const report = await deps.fetchReport({ refresh, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      emit({
        report,
        error: null,
        loading: false,
        refreshing: false,
        receivedAt: deps.now(),
      });
    } catch (e) {
      if (ctrl.signal.aborted && !timedOut) return;
      const message = timedOut
        ? "The network check timed out"
        : e instanceof Error
          ? e.message
          : String(e);
      emit({ ...snapshot, error: message, loading: false, refreshing: false });
    } finally {
      clearTimeout(killer);
      if (inflight === ctrl) inflight = null;
      if (id === seq) {
        lastDone = deps.now();
        schedule(settling() ? SETTLE_MS : deps.intervalMs);
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Starts polling. Returns a stop function. */
    start() {
      running = true;
      void check(false);
      return () => {
        running = false;
        inflight?.abort();
        inflight = null;
        clear();
        if (snapshot.refreshing) emit({ ...snapshot, refreshing: false });
      };
    },
    /** Hidden stops the timer. Visible checks only if the last check is older
     * than the interval, so switching tabs doesn't trigger a lookup. */
    visibilityChanged() {
      if (deps.isHidden()) return clear();
      if (!running || inflight) return;
      const age = deps.now() - lastDone;
      if (age >= deps.intervalMs) void check(false);
      else schedule(deps.intervalMs - age);
    },
    /** Checks now unless the last check is younger than `maxAgeMs`. */
    checkIfOlder(maxAgeMs: number) {
      if (running && !inflight && deps.now() - lastDone >= maxAgeMs)
        void check(false);
    },
    /** "Check again": forces a fresh probe and wins over a timed check. */
    refresh: () => check(true),
  };
}

export type NetworkStore = ReturnType<typeof createNetworkStore>;

/** Re-check delay while stash is restarting. */
export const SETTLE_MS = 2000;

export const NETWORK_INTERVAL_MS = 120_000;

export const network = createNetworkStore({
  fetchReport: (opts) => api.network(opts),
  intervalMs: NETWORK_INTERVAL_MS,
  isHidden: () => typeof document !== "undefined" && document.hidden,
  now: () => Date.now(),
});

/** Re-renders every 30 s as well, so a report that ages into "stale"
 * stops showing its verdict even when nothing else re-renders. */
export function useNetwork(store: NetworkStore = network): NetworkSnapshot {
  const snap = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return snap;
}
