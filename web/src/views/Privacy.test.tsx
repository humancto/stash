import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Privacy, waitForRestart } from "./Privacy";

const settings = (over: Record<string, unknown> = {}) => ({
  vpn: "strict",
  vpn_interface: null,
  vpn_from: "default",
  blocklist: true,
  blocklist_source: "https://raw.githubusercontent.com/Naunter/BT_BlockLists/master/bt_blocklists.gz",
  blocklist_from: "default",
  blocklist_status: { source: null, updated_at: null, ranges: 10, in_use: false, fetching: false, error: null },
  listen_port: null,
  restart_pending: false,
  boot_id: "old",
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("waitForRestart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores the old process and returns the new one", async () => {
    const answers: (() => Response)[] = [
      () => json(settings({ restart_pending: true })), // old process, still up
      () => {
        throw new TypeError("Failed to fetch"); // exec gap
      },
      () => json(settings()), // same boot id: not restarted yet
      () => json(settings({ boot_id: "new", vpn: "warn" })),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (answers.shift() ?? (() => json(settings({ boot_id: "new" }))))()),
    );
    const p = waitForRestart("old", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    const s = await p;
    expect(s?.bootId).toBe("new");
    expect(s?.vpn).toBe("warn");
  });

  it("gives up after its tries and stops when aborted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(settings())));
    const p = waitForRestart("old", new AbortController().signal, 3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeNull();

    const ctrl = new AbortController();
    const fetchMock = vi.fn(async () => json(settings()));
    vi.stubGlobal("fetch", fetchMock);
    const q = waitForRestart("old", ctrl.signal);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await q).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Privacy page", () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderPage() {
    const router = createMemoryRouter([{ path: "*", element: <Privacy /> }], { initialEntries: ["/privacy"] });
    render(<RouterProvider router={router} />);
  }

  it("env-locked radios stay focusable, refuse changes and say why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(settings({ vpn_from: "env" }))));
    renderPage();
    const warn = await screen.findByRole("radio", { name: /Warn/ });
    expect(warn).not.toBeDisabled();
    expect(warn).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Set by/)).toHaveTextContent("STASH_VPN");
    await userEvent.click(warn);
    expect(screen.getByRole("radio", { name: /Strict/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save and restart" })).toHaveAttribute("aria-disabled", "true");
  });

  it("Restart to apply is refused while there are unsaved changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(settings())));
    renderPage();
    const restart = await screen.findByRole("button", { name: /Restart to apply/ });
    expect(restart).not.toHaveAttribute("aria-disabled");
    await userEvent.click(screen.getByRole("radio", { name: /Warn/ }));
    expect(restart).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a loading line before the settings arrive", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderPage();
    expect(screen.getByText("Loading settings…")).toBeInTheDocument();
  });
});
