import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "../App";
import { ConfirmDelete } from "../components/ConfirmDelete";
import { api, ApiError } from "../lib/api";

const file = (name: string, included = true) => ({
  name,
  components: [name],
  length: 100,
  included,
  attributes: { padding: false, hidden: false },
});
const stats = {
  state: "paused",
  error: null,
  progress_bytes: 200,
  total_bytes: 200,
  finished: true,
  file_progress: [100, 100],
  live: null,
};

const reconnecting = {
  verdict: "tunnel",
  checked_at: Math.floor(Date.now() / 1000),
  lookup_enabled: false,
  ipv4: { route: false },
  ipv6: { route: false },
  kill_switch: {
    level: "strict",
    interface: null,
    level_from: "default",
    bound_to: null,
    state: "reconnecting",
    restart_reason: "vpn",
    listen_port: null,
    accepting_writes: false,
    boot_id: "b1",
  },
};

/** Two transfers: "Pair" (a.mp4, b.srt) and "Solo" (solo.mkv). Pair is the
 * newer one (listed first) when `pairId` is 1. */
function server({ pairId = 0, paused = false } = {}) {
  const soloId = pairId === 0 ? 1 : 0;
  const state = { pairDeleted: [] as number[], soloGone: false };
  const calls: string[] = [];
  const transfers = () => ({
    torrents: [
      {
        id: pairId,
        info_hash: "aa",
        name: "Pair",
        files: [
          file("a.mp4", !state.pairDeleted.includes(0)),
          file("b.srt", !state.pairDeleted.includes(1)),
        ],
        stats,
        deleted: state.pairDeleted,
      },
      ...(state.soloGone
        ? []
        : [
            {
              id: soloId,
              info_hash: "bb",
              name: "Solo",
              files: [file("solo.mkv")],
              stats,
              deleted: [],
            },
          ]),
    ],
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (init?.method === "DELETE") {
      calls.push(url);
      const m = /^\/api\/transfers\/(\d+)\/files\/(\d+)$/.exec(url);
      if (m && Number(m[1]) === pairId)
        state.pairDeleted = [...state.pairDeleted, Number(m[2])];
      if (url === `/api/transfers/${soloId}`) state.soloGone = true;
      return new Response(JSON.stringify({ freed_bytes: 100 }));
    }
    if (url.startsWith("/api/network"))
      return paused
        ? new Response(JSON.stringify(reconnecting))
        : new Response("{}", { status: 503 });
    return new Response(JSON.stringify(transfers()));
  });
  vi.stubGlobal("fetch", fetch);
  return { state, calls };
}

const open = (path: string) =>
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [path] })}
    />,
  );

describe("deleting one file", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes a row's file from the Files list and keeps focus in the list", async () => {
    const { calls } = server();
    open("/files");
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete “a.mp4”" }),
    );
    expect(
      screen.getByText(
        "Delete this file from disk? stash won't download it again.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByText("a.mp4")).not.toBeInTheDocument(),
    );
    expect(calls).toEqual(["/api/transfers/0/files/0"]);
    // b.srt is now the transfer's only file: it offers the transfer delete.
    expect(
      screen.getByRole("button", { name: "Delete transfer “Pair”" }),
    ).toBeInTheDocument();
    expect(document.activeElement?.getAttribute("data-key")).toBe("0:1");
    expect(screen.getByText("Deleted “a.mp4”")).toBeInTheDocument();
  });

  it("deletes the whole transfer for its only file", async () => {
    const { calls } = server();
    open("/files");
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete transfer “Solo”" }),
    );
    expect(
      screen.getByText("Delete the whole transfer “Solo” from disk?"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual(["/api/transfers/1"]));
    await waitFor(() =>
      expect(screen.queryByText("solo.mkv")).not.toBeInTheDocument(),
    );
    // Solo was the first row: focus moves to the next one.
    expect(document.activeElement?.getAttribute("data-key")).toBe("0:0");
  });

  it("offers Delete file on the file page only when other files remain", async () => {
    server();
    const solo = open("/watch/1/0");
    expect(
      await screen.findByRole("heading", { name: "solo.mkv" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete file" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete transfer" }),
    ).toBeInTheDocument();
    solo.unmount();
    open("/watch/0/0");
    expect(
      await screen.findByRole("heading", { name: "a.mp4" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(screen.getByText(/Delete “a\.mp4” from disk\?/)).toBeInTheDocument();
  });

  it("deleting from the file page lands on Files with focus past the deleted row", async () => {
    // Pair is newest, so its a.mp4 is the first row and still listed until
    // the refresh lands.
    const { calls } = server({ pairId: 1 });
    open("/watch/1/0");
    await userEvent.click(await screen.findByRole("button", { name: "Delete file" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("a.mp4")).not.toBeInTheDocument());
    expect(calls).toEqual(["/api/transfers/1/files/0"]);
    expect(document.activeElement?.getAttribute("data-key")).toBe("1:1");
  });

  it("refuses deletes while stash is restarting", async () => {
    const { calls } = server({ paused: true });
    open("/files");
    const del = await screen.findByRole("button", { name: "Delete “a.mp4”" });
    await waitFor(() => expect(del).toHaveAttribute("aria-disabled", "true"));
    expect(del).toHaveAttribute("title", expect.stringMatching(/restarting/));
    await userEvent.click(del);
    expect(screen.queryByText(/from disk\?/)).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("puts the file page's deletes in the remote's Up/Down list", async () => {
    server();
    open("/watch/0/0");
    expect(await screen.findByRole("heading", { name: "a.mp4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete file" })).toHaveAttribute("data-rove-item");
    expect(screen.getByRole("button", { name: "Delete transfer" })).toHaveAttribute("data-rove-item");
    await userEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(screen.getByRole("button", { name: "Keep" })).toHaveAttribute("data-rove-item");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("data-rove-item");
  });

  it("shows a deleted file's page without player or links", async () => {
    const { state } = server();
    state.pairDeleted = [0];
    open("/watch/0/0");
    expect(
      await screen.findByRole("heading", { name: "This file was deleted" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Download/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Copy stream link/ }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("video, audio")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Files" })).toHaveAttribute(
      "href",
      "/files",
    );
  });
});

describe("removeFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends DELETE to the file's path and surfaces the server's message", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            human_readable:
              "This is the last file in the transfer. Delete the transfer instead.",
          }),
          { status: 409 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const err = await api.removeFile(4, 2).catch((e: unknown) => e);
    expect(fetch).toHaveBeenCalledWith("/api/transfers/4/files/2", {
      method: "DELETE",
    });
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toMatch(/last file/);
  });
});

describe("ConfirmDelete options", () => {
  it("uses the prompt and accessible name, announces errors, and resets after success", async () => {
    let fail = true;
    const onConfirm = vi.fn(async () => {
      if (fail) throw new Error("still checking");
    });
    render(
      <ConfirmDelete
        what="x"
        label=""
        ariaLabel="Delete “x.mkv”"
        prompt="Delete this file?"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete “x.mkv”" }),
    );
    expect(screen.getByText("Delete this file?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "still checking",
    );
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    // Still mounted after success: back to the trigger, not stuck on "Deleting…".
    expect(
      await screen.findByRole("button", { name: "Delete “x.mkv”" }),
    ).toBeEnabled();
  });
});
