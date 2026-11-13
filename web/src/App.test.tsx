import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "./App";

const body = {
  torrents: [
    {
      id: 0,
      info_hash: "dd82",
      name: "Big Buck Bunny",
      files: [
        { name: "Big Buck Bunny.mp4", components: ["Big Buck Bunny.mp4"], length: 1000, included: true, attributes: { padding: false, hidden: false } },
      ],
      stats: { state: "live", error: null, progress_bytes: 1000, total_bytes: 1000, finished: true, file_progress: [1000], live: null },
    },
  ],
};

describe("routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deep links to a file page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/watch/0/0"] })} />);
    expect(await screen.findByRole("heading", { name: "Big Buck Bunny.mp4" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute("href", "/api/transfers/0/files/0?download=1");
  });

  it("shows a clear page for a file that is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/watch/5/0"] })} />);
    expect(await screen.findByText("This file isn't here")).toBeInTheDocument();
  });

  it("redirects unknown routes to Files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/nope"] })} />);
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
  });

  it("Escape on a deep-linked file page goes to Files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    const router = createMemoryRouter(routes, { initialEntries: ["/watch/0/0"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Big Buck Bunny.mp4" });
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
  });

  it("Escape in the search box only leaves the search box", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    const router = createMemoryRouter(routes, { initialEntries: ["/files", "/watch/0/0"], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Big Buck Bunny.mp4" });
    await userEvent.click(screen.getByLabelText("Search files"));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "Big Buck Bunny.mp4" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/watch/0/0");
  });

  it("says stash is unreachable instead of 'missing' when the first load fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("connection refused", { status: 502 })));
    // The transfer store is a module singleton; load a fresh copy so data
    // from earlier tests can't mask the failure.
    vi.resetModules();
    const fresh = await import("./App");
    const rr = await import("react-router");
    render(<rr.RouterProvider router={rr.createMemoryRouter(fresh.routes, { initialEntries: ["/watch/0/0"] })} />);
    expect(await screen.findByText("Can't reach stash")).toBeInTheDocument();
    expect(screen.queryByText("This file isn't here")).not.toBeInTheDocument();
  });
});
