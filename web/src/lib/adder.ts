// The one place transfers are added from: the add box, paste, drop, the
// Open .torrent button and the /add page all go through `adder.add`, so the
// paused check, busy state and errors are shared.

import { useSyncExternalStore } from "react";
import { pausedReason } from "../components/NetworkStatus";
import { api } from "./api";
import { filesProblem } from "./magnet";
import { network } from "./network";
import { transfers } from "./store";

export type AddSource =
  | { kind: "url"; url: string }
  | { kind: "files"; files: File[] };

export interface AdderSnapshot {
  busy: boolean;
  /** Shown as an alert next to the add box. */
  error: string | null;
  /** A polite status ("Added …") when the page does not change. */
  status: string | null;
}

export interface AdderDeps {
  addUrl: (url: string) => Promise<void>;
  addFile: (file: File) => Promise<void>;
  paused: () => string | null;
}

const message = (e: unknown) =>
  e instanceof Error ? e.message : "Could not add that.";

export function createAdder(deps: AdderDeps) {
  let snapshot: AdderSnapshot = { busy: false, error: null, status: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<AdderSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const l of listeners) l();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    clear() {
      if (snapshot.error || snapshot.status) set({ error: null, status: null });
    },
    /** Resolves true when everything was added. */
    async add(source: AddSource): Promise<boolean> {
      if (snapshot.busy) {
        set({ error: "Still adding the last one. Try again in a moment." });
        return false;
      }
      const paused = deps.paused();
      if (paused) {
        set({ error: paused, status: null });
        return false;
      }
      if (source.kind === "url" && !source.url.trim()) {
        set({ error: "Paste a magnet link or a .torrent URL first.", status: null });
        return false;
      }
      if (source.kind === "files") {
        const problem = filesProblem(source.files);
        if (problem) {
          set({ error: problem, status: null });
          return false;
        }
      }
      set({ busy: true, error: null, status: null });
      try {
        if (source.kind === "url") {
          try {
            await deps.addUrl(source.url.trim());
          } catch (e) {
            set({ error: message(e) });
            return false;
          }
        } else {
          const { files } = source;
          for (const [i, f] of files.entries()) {
            try {
              await deps.addFile(f);
            } catch (e) {
              set({
                error:
                  files.length > 1
                    ? `Added ${i} of ${files.length}. ${f.name}: ${message(e)}`
                    : message(e),
              });
              return false;
            }
          }
        }
        return true;
      } finally {
        set({ busy: false });
      }
    },
    fail(error: string) {
      set({ error, status: null });
    },
    setStatus(status: string | null) {
      set({ status });
    },
  };
}

export type Adder = ReturnType<typeof createAdder>;

export const adder = createAdder({
  addUrl: (url) => transfers.mutate(() => api.add(url)),
  addFile: (file) => transfers.mutate(() => api.addTorrentFile(file)),
  paused: () => pausedReason(network.getSnapshot(), Date.now()),
});

export function useAdder(store: Adder = adder): AdderSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
