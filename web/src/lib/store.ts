// One shared poller for /api/transfers. Every view reads the same snapshot
// through useSyncExternalStore, so there is never more than one request in
// flight per interval.

import { useSyncExternalStore } from "react";
import { api, type Transfer } from "./api";

export interface Snapshot {
  transfers: Transfer[];
  /** True until the first successful response. */
  loading: boolean;
  /** Message of the last failed poll; data is kept from the last success. */
  error: string | null;
}

export interface StoreDeps {
  fetchList: (signal: AbortSignal) => Promise<Transfer[]>;
  intervalMs: number;
  isHidden: () => boolean;
}

export function createTransferStore(deps: StoreDeps) {
  let snapshot: Snapshot = { transfers: [], loading: true, error: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let seq = 0; // id of the newest request started
  let applied = 0; // id of the newest response applied
  let running = false;
  let mutating = 0; // no timed polls while a mutation is in progress

  const emit = (next: Snapshot) => {
    snapshot = next;
    for (const l of listeners) l();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (running && mutating === 0 && !deps.isHidden())
      timer = setTimeout(() => void poll(), deps.intervalMs);
  };

  async function poll(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    const id = ++seq;
    try {
      const transfers = await deps.fetchList(ctrl.signal);
      // Aborted after the response arrived, or a newer request already landed.
      if (ctrl.signal.aborted || id < applied) return;
      applied = id;
      emit({ transfers, loading: false, error: null });
    } catch (e) {
      if (ctrl.signal.aborted || id < applied) return;
      applied = id;
      const message = e instanceof Error ? e.message : String(e);
      emit({ ...snapshot, loading: false, error: message });
    } finally {
      if (inflight === ctrl) inflight = null;
      if (id === seq) schedule();
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
      void poll();
      return () => {
        running = false;
        inflight?.abort();
        if (timer) clearTimeout(timer);
        timer = null;
      };
    },
    /** Call when tab visibility changes: hidden stops the timer, visible polls at once. */
    visibilityChanged() {
      if (deps.isHidden()) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (running) {
        void poll();
      }
    },
    /** Runs a mutation. The in-flight poll is aborted first so it can't land
     * after the mutation with stale state, then the list is refreshed. */
    async mutate(fn: () => Promise<void>): Promise<void> {
      mutating++;
      if (timer) clearTimeout(timer);
      timer = null;
      inflight?.abort();
      try {
        await fn();
      } finally {
        mutating--;
        await poll();
      }
    },
    refresh: () => poll(),
  };
}

export type TransferStore = ReturnType<typeof createTransferStore>;

export const transfers = createTransferStore({
  fetchList: (signal) => api.list(signal),
  intervalMs: 1500,
  isHidden: () => typeof document !== "undefined" && document.hidden,
});

export function useTransfers(store: TransferStore = transfers): Snapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
