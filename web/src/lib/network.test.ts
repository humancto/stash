import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseNetwork, type NetworkReport } from "./api";
import { createNetworkStore, isStale, type NetworkDeps } from "./network";

const wire = {
  verdict: "tunnel",
  checked_at: 1_700_000_000,
  lookup_enabled: true,
  ipv4: {
    route: true,
    interface: "utun4",
    tunnel: true,
    route_consistent: true,
    local_ip: "10.2.0.2",
    public_ip: "185.1.2.3",
    country: "NL",
    error: null,
  },
  ipv6: { route: false },
};

describe("parseNetwork", () => {
  it("parses a report with a routed and an unrouted family", () => {
    expect(parseNetwork(wire)).toEqual({
      verdict: "tunnel",
      checkedAt: 1_700_000_000,
      lookupEnabled: true,
      ipv4: {
        route: true,
        iface: "utun4",
        tunnel: true,
        routeConsistent: true,
        localIp: "10.2.0.2",
        publicIp: "185.1.2.3",
        country: "NL",
        error: null,
      },
      ipv6: { route: false },
    });
  });

  it("accepts lookup off with null IPs and a null interface", () => {
    const r = parseNetwork({
      ...wire,
      lookup_enabled: false,
      ipv4: { ...wire.ipv4, interface: null, public_ip: null, country: null },
    });
    expect(r.lookupEnabled).toBe(false);
    expect(r.ipv4).toMatchObject({ route: true, iface: null, publicIp: null });
  });

  it.each([
    ["unknown verdict", { ...wire, verdict: "partial" }],
    ["missing verdict", { ...wire, verdict: undefined }],
    ["non-finite checked_at", { ...wire, checked_at: Number.NaN }],
    ["missing lookup_enabled", { ...wire, lookup_enabled: undefined }],
    ["non-object family", { ...wire, ipv6: "nope" }],
    ["family without route", { ...wire, ipv6: {} }],
    [
      "routed family without local_ip",
      { ...wire, ipv4: { route: true, tunnel: false } },
    ],
    ["not an object", [1, 2]],
  ])("rejects %s", (_, v) => {
    expect(() => parseNetwork(v)).toThrow("unexpected network report");
  });
});

const report = (
  checkedAtMs: number,
  verdict: NetworkReport["verdict"] = "tunnel",
): NetworkReport => ({
  verdict,
  checkedAt: checkedAtMs / 1000,
  lookupEnabled: true,
  ipv4: { route: false },
  ipv6: { route: false },
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("network store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(over: Partial<NetworkDeps> = {}) {
    let hidden = false;
    const fetchReport = vi.fn(async () => report(Date.now()));
    const store = createNetworkStore({
      fetchReport,
      intervalMs: 1000,
      isHidden: () => hidden,
      now: () => Date.now(),
      ...over,
    });
    return { store, fetchReport, setHidden: (h: boolean) => (hidden = h) };
  }

  it("polls on the interval, stops when hidden, and does not re-check on a quick tab switch", async () => {
    const { store, fetchReport, setHidden } = setup();
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ loading: false, error: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchReport).toHaveBeenCalledTimes(2);

    setHidden(true);
    store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(300);
    setHidden(false);
    store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchReport).toHaveBeenCalledTimes(2); // inside the interval: no lookup
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchReport).toHaveBeenCalledTimes(3); // remainder of the interval

    setHidden(true);
    store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchReport).toHaveBeenCalledTimes(3);
    setHidden(false);
    store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchReport).toHaveBeenCalledTimes(4); // older than the interval: at once
    stop();
  });

  it("refresh sends refresh=true, beats an in-flight timed check, and resets the timer", async () => {
    const timed = deferred<NetworkReport>();
    const fetchReport = vi
      .fn<NetworkDeps["fetchReport"]>()
      .mockImplementationOnce(() => timed.promise)
      .mockImplementation(async () => report(Date.now(), "exposed"));
    const { store } = setup({ fetchReport });
    const stop = store.start();
    const refreshing = store.refresh();
    expect(store.getSnapshot().refreshing).toBe(true);
    const firstSignal = fetchReport.mock.calls[0]?.[0].signal;
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchReport.mock.calls[1]?.[0].refresh).toBe(true);
    await refreshing;
    timed.resolve(report(Date.now(), "tunnel")); // late answer is ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({
      refreshing: false,
      report: { verdict: "exposed" },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchReport).toHaveBeenCalledTimes(3);
    expect(fetchReport.mock.calls[2]?.[0].refresh).toBe(false);
    stop();
  });

  it("an error keeps the last report but marks it stale", async () => {
    const fetchReport = vi
      .fn<NetworkDeps["fetchReport"]>()
      .mockImplementationOnce(async () => report(Date.now()))
      .mockRejectedValue(new Error("Can't reach stash"));
    const { store } = setup({ fetchReport });
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(isStale(store.getSnapshot(), 1000, Date.now())).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const s = store.getSnapshot();
    expect(s.report?.verdict).toBe("tunnel");
    expect(s.error).toBe("Can't reach stash");
    expect(isStale(s, 1000, Date.now())).toBe(true);
    stop();
  });

  it("age is judged by when the browser received the report, not the server clock", () => {
    // Server clock far behind (checked_at 0) does not matter; receivedAt does.
    const s = {
      report: report(0),
      error: null,
      loading: false,
      refreshing: false,
      receivedAt: 1000,
    };
    expect(isStale(s, 1000, 2999)).toBe(false);
    expect(isStale(s, 1000, 3001)).toBe(true);
  });

  it("a hung check times out, records an error, and polling continues", async () => {
    const fetchReport = vi
      .fn<NetworkDeps["fetchReport"]>()
      .mockImplementationOnce(
        ({ signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      )
      .mockImplementation(async () => report(Date.now()));
    const { store } = setup({ fetchReport, timeoutMs: 500, intervalMs: 1000 });
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot().error).toBe("The network check timed out");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().error).toBeNull();
    stop();
  });

  it("checkIfOlder only checks when the report is old enough", async () => {
    const { store, fetchReport } = setup();
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0);
    store.checkIfOlder(500);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    store.checkIfOlder(500);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop aborts the in-flight check and stops the timer", async () => {
    const pending = deferred<NetworkReport>();
    const fetchReport = vi.fn<NetworkDeps["fetchReport"]>(
      () => pending.promise,
    );
    const { store } = setup({ fetchReport });
    const stop = store.start();
    stop();
    expect(fetchReport.mock.calls[0]?.[0].signal.aborted).toBe(true);
    pending.resolve(report(Date.now()));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().report).toBeNull();
  });
});
