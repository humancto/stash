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
      killSwitch: null,
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
  killSwitch: null,
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

describe("kill switch and settings parsing", () => {
  it("parses kill_switch and tolerates its absence", async () => {
    const { parseNetwork: parse } = await import("./api");
    const ks = {
      level: "warn",
      interface: null,
      level_from: "file",
      bound_to: "utun6",
      state: "bound",
      listen_port: null,
      accepting_writes: true,
      restart_reason: null,
      boot_id: "abc",
    };
    expect(parse({ ...wire, kill_switch: ks }).killSwitch).toEqual({
      level: "warn",
      interface: null,
      levelFrom: "file",
      boundTo: "utun6",
      state: "bound",
      restartReason: null,
      listenPort: null,
      acceptingWrites: true,
      bootId: "abc",
    });
    expect(parse(wire).killSwitch).toBeNull();
    expect(
      parse({ ...wire, kill_switch: { ...ks, state: "reconnecting", restart_reason: "settings" } })
        .killSwitch?.restartReason,
    ).toBe("settings");
  });

  it.each([
    ["unknown state", { state: "weird" }],
    ["unknown reason", { restart_reason: "moon" }],
    ["non-boolean accepting_writes", { accepting_writes: "yes" }],
    ["missing boot id", { boot_id: undefined }],
  ])("a malformed kill switch fails closed: %s", async (_, over) => {
    const { parseNetwork: parse } = await import("./api");
    const ks = {
      level: "strict",
      interface: null,
      level_from: "default",
      bound_to: "utun6",
      state: "bound",
      listen_port: null,
      accepting_writes: true,
      restart_reason: null,
      boot_id: "abc",
      ...over,
    };
    expect(() => parse({ ...wire, kill_switch: ks })).toThrow("unexpected kill switch");
  });

  it("parses settings and rejects unknown levels", async () => {
    const { parseSettings } = await import("./api");
    const body = {
      vpn: "strict",
      vpn_interface: null,
      vpn_from: "env",
      blocklist: false,
      blocklist_source: null,
      blocklist_from: "file",
      blocklist_status: { source: null, updated_at: null, ranges: null, in_use: false, fetching: false, error: null },
      listen_port: 51413,
      restart_pending: false,
      boot_id: "b1",
      seeding: { mode: "ratio", ratio: 1.5 },
      seeding_from: "file",
    };
    expect(parseSettings(body)).toMatchObject({ vpn: "strict", vpnFrom: "env", blocklist: false, listenPort: 51413 });
    expect(() => parseSettings({ ...body, vpn: "auto" })).toThrow("unexpected settings");
    expect(() => parseSettings({ ...body, blocklist_status: null })).toThrow("unexpected settings");
    expect(() => parseSettings({ ...body, boot_id: 5 })).toThrow("unexpected settings");
  });
});

describe("network store while stash restarts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-checks every 2 s while reconnecting, then back to the interval", async () => {
    const ks = (state: "reconnecting" | "bound") => ({
      level: "strict" as const,
      interface: null,
      levelFrom: "default" as const,
      boundTo: "utun6",
      state,
      restartReason: "vpn" as const,
      listenPort: null,
      acceptingWrites: state !== "reconnecting",
      bootId: state,
    });
    const fetchReport = vi
      .fn<NetworkDeps["fetchReport"]>()
      .mockImplementationOnce(async () => ({ ...report(Date.now()), killSwitch: ks("reconnecting") }))
      .mockImplementation(async () => ({ ...report(Date.now()), killSwitch: ks("bound") }));
    const store = createNetworkStore({
      fetchReport,
      intervalMs: 60_000,
      isHidden: () => false,
      now: () => Date.now(),
    });
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().report?.killSwitch?.state).toBe("bound");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("restart failed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not keep re-checking every 2 s when stash can't restart", async () => {
    const fetchReport = vi.fn<NetworkDeps["fetchReport"]>(async () => ({
      ...report(Date.now()),
      killSwitch: {
        level: "strict",
        interface: null,
        levelFrom: "default",
        boundTo: null,
        state: "restart_failed",
        restartReason: "vpn",
        listenPort: null,
        acceptingWrites: false,
        bootId: "b",
      },
    }));
    const store = createNetworkStore({ fetchReport, intervalMs: 60_000, isHidden: () => false, now: () => Date.now() });
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    stop();
  });

  it("parses restart_failed", async () => {
    const { parseNetwork: parse } = await import("./api");
    const ks = {
      level: "strict", interface: null, level_from: "default", bound_to: null,
      state: "restart_failed", listen_port: null, accepting_writes: false,
      restart_reason: "vpn", boot_id: "b",
    };
    expect(parse({ ...wire, kill_switch: ks }).killSwitch?.state).toBe("restart_failed");
  });
});
