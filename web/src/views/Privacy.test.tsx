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
  seeding: { mode: "stop" },
  seeding_from: "default",
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
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
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

  it("a seeding-only save applies at once: one PUT, one GET, no restart wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    let current = settings();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "PUT") {
          current = settings({ seeding: JSON.parse(String(init.body)).seeding, seeding_from: "file" });
          return json({ restart: false });
        }
        return json(current);
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole("radio", { name: /Until a ratio/ }));
    const ratio = screen.getByRole("textbox", { name: "Ratio" });
    await userEvent.clear(ratio);
    await userEvent.type(ratio, "1,5");
    const save = screen.getByRole("button", { name: "Save" });
    await userEvent.click(save);
    expect(await screen.findByText("Saved. It applies now.")).toBeInTheDocument();
    const after = calls.slice(calls.indexOf("PUT /api/settings"));
    expect(after).toEqual(["PUT /api/settings", "GET /api/settings"]);
    expect(current.seeding).toEqual({ mode: "ratio", ratio: 1.5 });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(screen.queryByText(/didn't come back/)).toBeNull();
    expect(save).toHaveAttribute("aria-disabled", "true");
    vi.useRealTimers();
  });

  it("a mixed save restarts and checks seeding took effect too", async () => {
    let put: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          put = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ restart: true }), { status: 202 });
        }
        // New process, but seeding didn't stick.
        return put ? json(settings({ boot_id: "new", vpn: "warn" })) : json(settings());
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole("radio", { name: /Warn/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Keep seeding/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    expect(put).toEqual({ vpn: "warn", seeding: { mode: "forever" } });
    expect(
      await screen.findByText(/didn't take effect/, {}, { timeout: 5000 }),
    ).toHaveAttribute("role", "alert");
  });

  it("env-locked seeding is never sent with a vpn change", async () => {
    let put: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          put = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ restart: true }), { status: 202 });
        }
        return json(settings({ seeding: { mode: "time", minutes: 1 }, seeding_from: "env" }));
      }),
    );
    renderPage();
    expect((await screen.findByText(/STASH_SEEDING/)).closest("p")).toHaveTextContent(
      "For 1 minute after it finishes",
    );
    await userEvent.click(screen.getByRole("radio", { name: /Keep seeding/ }));
    expect(screen.getByRole("radio", { name: /For a while/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /Warn/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    expect(put).toEqual({ vpn: "warn" });
  });

  it.each([
    ["", true],
    ["abc", true],
    ["0", true],
    ["101", true],
    ["1,5", false],
    ["1.50", false],
  ])("ratio %j invalid=%s", async (text, invalid) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(settings({ seeding: { mode: "ratio", ratio: 1.5 }, seeding_from: "file" }))));
    renderPage();
    const ratio = await screen.findByRole("textbox", { name: "Ratio" });
    await userEvent.clear(ratio);
    if (text) await userEvent.type(ratio, text);
    const save = screen.getByRole("button", { name: "Save" });
    if (invalid) {
      expect(ratio).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText(/Enter a ratio/)).toBeInTheDocument();
      expect(save).toHaveAttribute("aria-disabled", "true");
    } else {
      expect(ratio).not.toHaveAttribute("aria-invalid");
      // "1.50" and "1,5" equal the saved 1.5: nothing to save.
      expect(save).toHaveAttribute("aria-disabled", "true");
    }
  });
});
