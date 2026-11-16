import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Family, NetworkReport } from "../lib/api";
import type { NetworkSnapshot } from "../lib/network";

// The components read the module singleton; drive it through a fake.
const state = vi.hoisted(() => ({
  snap: {
    report: null,
    error: null,
    loading: true,
    refreshing: false,
    receivedAt: null,
  } as NetworkSnapshot,
  listeners: new Set<() => void>(),
  refresh: vi.fn(async () => {}),
  checkIfOlder: vi.fn(),
}));

vi.mock("../lib/network", async (orig) => {
  const real = await orig<typeof import("../lib/network")>();
  const fake = {
    getSnapshot: () => state.snap,
    subscribe: (l: () => void) => {
      state.listeners.add(l);
      return () => state.listeners.delete(l);
    },
    refresh: state.refresh,
    checkIfOlder: state.checkIfOlder,
  };
  return {
    ...real,
    network: fake,
    useNetwork: () => real.useNetwork(fake as never),
  };
});

const { NetworkChip, NetworkPanel } = await import("./NetworkStatus");

function set(snap: Partial<NetworkSnapshot>) {
  act(() => {
    state.snap = {
      report: null,
      error: null,
      loading: false,
      refreshing: false,
      receivedAt: snap.report ? Date.now() : null,
      ...snap,
    };
    for (const l of state.listeners) l();
  });
}

const now = () => Math.floor(Date.now() / 1000);

type Routed = Extract<Family, { route: true }>;

const routed = (over: Partial<Routed> = {}): Routed => ({
  route: true,
  iface: "utun4",
  tunnel: true,
  routeConsistent: true,
  localIp: "10.2.0.2",
  publicIp: "185.1.2.3",
  country: "NL",
  error: null,
  ...over,
});

const report = (over: Partial<NetworkReport> = {}): NetworkReport => ({
  verdict: "tunnel",
  checkedAt: now(),
  lookupEnabled: true,
  ipv4: routed(),
  ipv6: { route: false },
  ...over,
});

function renderAt(el: React.ReactElement, path = "/transfers") {
  const router = createMemoryRouter([{ path: "*", element: el }], {
    initialEntries: [path],
  });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  state.snap = {
    report: null,
    error: null,
    loading: true,
    refreshing: false,
    receivedAt: null,
  };
  state.refresh.mockClear();
  state.checkIfOlder.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});
const originalScroll = Element.prototype.scrollIntoView;
afterEach(() => {
  state.listeners.clear();
  Element.prototype.scrollIntoView = originalScroll;
});

describe("NetworkChip", () => {
  it.each([
    [{ loading: true }, "Checking", /Checking the network/],
    [{ report: report() }, "VPN tunnel", /looks like a VPN tunnel/],
    [{ report: report({ verdict: "exposed" }) }, "No VPN", /No VPN tunnel/],
    [
      { report: report({ verdict: "offline" }) },
      "Offline",
      /no internet route/,
    ],
    [{ report: report(), error: "Can't reach stash" }, "Unknown", /unknown/],
    [{ report: report(), receivedAt: Date.now() - 3_600_000 }, "Unknown", /unknown/],
  ] as const)("%o shows %s", (snap, word, name) => {
    renderAt(<NetworkChip />);
    set(snap);
    const link = screen.getByRole("link", { name });
    expect(link).toHaveTextContent(word);
    expect(link).toHaveAttribute("href", "/transfers#network");
    expect(link).not.toHaveTextContent("185.1.2.3");
  });
});

describe("NetworkPanel", () => {
  it("says what peers see through a tunnel, with hedged wording", () => {
    renderAt(<NetworkPanel />);
    set({ report: report() });
    const h = screen.getByRole("heading", { level: 2 });
    expect(h).toHaveTextContent(
      "Peers see 185.1.2.3 (NL). stash's traffic leaves through utun4, which looks like a VPN tunnel.",
    );
    expect(h.textContent).not.toMatch(/safe/i);
    expect(
      screen.getByText(/If the VPN drops, stash keeps running/),
    ).toBeInTheDocument();
  });

  it("names the exposure without claiming it is the viewer's own IP", () => {
    renderAt(<NetworkPanel />);
    set({
      report: report({
        verdict: "exposed",
        ipv4: routed({ tunnel: false, iface: "en0" }),
      }),
    });
    const h = screen.getByRole("heading", { level: 2 });
    expect(h).toHaveTextContent(
      "Peers see 185.1.2.3 (NL). stash's traffic does not leave through a VPN tunnel",
    );
    expect(h.textContent).not.toMatch(/your own/i);
  });

  it("offline has no details toggle", () => {
    renderAt(<NetworkPanel />);
    set({ report: report({ verdict: "offline", ipv4: { route: false } }) });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "stash has no internet route right now.",
    );
    expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
  });

  it("details show both families, lookup errors and split routes", async () => {
    renderAt(<NetworkPanel />);
    set({
      report: report({
        verdict: "exposed",
        ipv4: routed({
          publicIp: null,
          country: null,
          error: "Lookup timed out",
          routeConsistent: false,
        }),
        ipv6: {
          route: true,
          iface: "en0",
          tunnel: false,
          routeConsistent: true,
          localIp: "2603::1",
          publicIp: "2603::1",
          country: "US",
          error: null,
        },
      }),
    });
    const toggle = screen.getByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Lookup timed out")).toBeInTheDocument();
    expect(
      screen.getByText("Some traffic takes a different route."),
    ).toBeInTheDocument();
    expect(screen.getByText("Peers see: 2603::1 (US)")).toBeInTheDocument();
  });

  it("says when the lookup is off", () => {
    renderAt(<NetworkPanel />);
    set({
      report: report({
        lookupEnabled: false,
        ipv4: routed({ publicIp: null, country: null }),
      }),
    });
    expect(screen.getByText(/Public IP lookup is off/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      /^stash's traffic leaves through utun4/,
    );
  });

  it("Check again is busy while in flight and announces the result", async () => {
    renderAt(<NetworkPanel />);
    set({ report: report() });
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    set({ report: report(), refreshing: true });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    set({ report: report({ verdict: "exposed" }) });
    expect(screen.getByRole("status")).toHaveTextContent("No VPN tunnel");
  });

  it("freshens an old report on mount", () => {
    renderAt(<NetworkPanel />);
    expect(state.checkIfOlder).toHaveBeenCalledWith(30_000);
  });

  it("the #network hash scrolls to and focuses the heading", () => {
    renderAt(<NetworkPanel />, "/transfers#network");
    set({ report: report() });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2 })).toHaveFocus();
  });
  it("a stale report hides the verdict and the details", async () => {
    renderAt(<NetworkPanel />);
    set({ report: report() });
    await userEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText("utun4 · looks like a VPN tunnel")).toBeInTheDocument();
    set({ report: report(), receivedAt: Date.now() - 3_600_000 });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("The last check is out of date.");
    expect(screen.queryAllByText(/looks like a VPN tunnel/)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
    set({ report: report(), error: "Lookup failed." });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Couldn't check what peers can see.");
    expect(screen.getByText(/Lookup failed\./).textContent).not.toMatch(/\.\./);
  });

  it("announces a verdict change without a user action, but not the first load", () => {
    renderAt(<NetworkPanel />);
    set({ report: report() });
    expect(screen.getByRole("status")).toHaveTextContent("");
    set({ report: report({ verdict: "exposed" }) });
    expect(screen.getByRole("status")).toHaveTextContent("No VPN tunnel");
  });

  it("scrolls the section (which has the scroll margin), not the heading", () => {
    const calls: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    renderAt(<NetworkPanel />, "/transfers#network");
    expect(calls[0]?.id).toBe("network");
  });
});
