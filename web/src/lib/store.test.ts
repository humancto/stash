import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transfer } from "./api";
import { createTransferStore } from "./store";

const t = (id: number, name: string): Transfer => ({ id, infoHash: String(id), name, files: null, stats: null });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("transfer store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls on an interval and stops when hidden", async () => {
    let hidden = false;
    const fetchList = vi.fn(async () => [t(1, "a")]);
    const store = createTransferStore({ fetchList, intervalMs: 1000, isHidden: () => hidden });
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ loading: false, error: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchList).toHaveBeenCalledTimes(2);
    hidden = true;
    store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchList).toHaveBeenCalledTimes(2);
    hidden = false;
    store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchList).toHaveBeenCalledTimes(3);
    stop();
  });

  it("a poll in flight during a mutation never overwrites the result", async () => {
    const slow = deferred<Transfer[]>();
    let call = 0;
    const fetchList = vi.fn((signal: AbortSignal) => {
      call++;
      if (call === 1) {
        signal.addEventListener("abort", () => slow.reject(new DOMException("aborted", "AbortError")));
        return slow.promise;
      }
      return Promise.resolve([t(1, "after-mutation")]);
    });
    const store = createTransferStore({ fetchList, intervalMs: 1000, isHidden: () => false });
    store.start();
    await store.mutate(async () => {});
    slow.resolve([t(1, "stale")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().transfers[0]?.name).toBe("after-mutation");
  });

  it("drops responses older than the newest applied", async () => {
    const first = deferred<Transfer[]>();
    let call = 0;
    const fetchList = vi.fn(() => (++call === 1 ? first.promise : Promise.resolve([t(1, "new")])));
    const store = createTransferStore({ fetchList, intervalMs: 1000, isHidden: () => false });
    store.start(); // request 1 (never aborted: fetchList ignores the signal)
    await store.refresh(); // request 2 lands
    first.resolve([t(1, "old")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().transfers[0]?.name).toBe("new");
  });

  it("keeps the last good data when a poll fails", async () => {
    let fail = false;
    const fetchList = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return [t(1, "a")];
    });
    const store = createTransferStore({ fetchList, intervalMs: 1000, isHidden: () => false });
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot()).toMatchObject({ error: "offline", transfers: [{ name: "a" }] });
  });

  it("stop aborts the in-flight request and stops the timer", async () => {
    let aborted = false;
    const fetchList = vi.fn(
      (signal: AbortSignal) =>
        new Promise<Transfer[]>((_, rej) => signal.addEventListener("abort", () => ((aborted = true), rej(new Error("abort"))))),
    );
    const store = createTransferStore({ fetchList, intervalMs: 1000, isHidden: () => false });
    const stop = store.start();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(aborted).toBe(true);
    expect(fetchList).toHaveBeenCalledTimes(1);
  });
});

describe("transfer store aborts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops a response that resolved but whose request was then aborted", async () => {
    const gate = deferred<void>();
    let call = 0;
    const fetchList = vi.fn(async () => {
      call++;
      if (call === 1) {
        await gate.promise; // resolves only after the abort below
        return [t(1, "aborted")];
      }
      return [t(1, "fresh")];
    });
    const store = createTransferStore({ fetchList, intervalMs: 1000, isHidden: () => false });
    store.start();
    const mutation = store.mutate(async () => {
      gate.resolve(); // first request "completes" after it was aborted
    });
    await mutation;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().transfers[0]?.name).toBe("fresh");
  });
});
