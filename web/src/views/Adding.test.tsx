import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../App";
import { createAdder } from "../lib/adder";
import { handleNavKey } from "../lib/keys";
import {
  filesProblem,
  isTorrentLink,
  parseMagnet,
  TORRENT_MAX_BYTES,
} from "../lib/magnet";

const HASH = "c9e15763f722f23e98a29decdfae341b98d53056";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Big+Buck%2BBunny&tr=udp%3A%2F%2Fx`;

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

interface Post {
  type: string | null;
  body: unknown;
}

function server({ paused = false } = {}) {
  const posts: Post[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (init?.method === "POST" && url === "/api/transfers") {
      const type = new Headers(init.headers).get("content-type");
      posts.push({
        type,
        body:
          type === "application/json"
            ? JSON.parse(String(init.body))
            : init.body,
      });
      return new Response(JSON.stringify({ id: 1 }));
    }
    if (url.startsWith("/api/network"))
      return paused
        ? new Response(JSON.stringify(reconnecting))
        : new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ torrents: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  return { posts };
}

function open(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const torrent = (name = "a.torrent", size = 10) =>
  new File([new Uint8Array(size).fill(100)], name, {
    type: "application/x-bittorrent",
  });

describe("parseMagnet", () => {
  it("reads the hash and name", () => {
    expect(parseMagnet(MAGNET)).toEqual({ hash: HASH, name: "Big Buck+Bunny" });
    expect(parseMagnet(`MAGNET:?xt=urn:btih:${HASH.toUpperCase()}`)).toEqual({
      hash: HASH,
      name: null,
    });
    expect(
      parseMagnet("magnet:?xt=urn:btih:abcdefghijklmnopqrstuvwxyz234567")?.hash,
    ).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    expect(parseMagnet(`magnet:?xt=urn:btmh:1220${"a".repeat(64)}`)?.hash).toBe(
      `1220${"a".repeat(64)}`,
    );
  });

  it("refuses what isn't a magnet", () => {
    for (const s of [
      `magnet:xt=urn:btih:${HASH}`,
      "magnet:?dn=x",
      "magnet:?xt=urn:btih:zz",
      `https://x/?xt=urn:btih:${HASH}`,
      "",
      // Several xt, or an unusual prefix case: the engine could read
      // something other than what the page shows.
      `magnet:?xt=urn:x:1&xt=urn:btih:${HASH}`,
      `magnet:?xt=urn:btih:${HASH}&xt=urn:btih:${"b".repeat(40)}`,
      `magnet:?xt=URN:BTIH:${HASH}`,
    ])
      expect(parseMagnet(s), s).toBeNull();
  });
});

describe("isTorrentLink and filesProblem", () => {
  it("only claims links meant to be added", () => {
    expect(isTorrentLink(` ${MAGNET} `)).toBe(true);
    expect(isTorrentLink(HASH)).toBe(true);
    expect(isTorrentLink("https://example.com/dl/a.torrent?passkey=1")).toBe(
      true,
    );
    expect(isTorrentLink("https://example.com/page")).toBe(false);
    expect(isTorrentLink("some words a.torrent")).toBe(false);
    expect(isTorrentLink("file:///a.torrent")).toBe(false);
  });

  it("checks a whole batch", () => {
    expect(filesProblem([torrent()])).toBeNull();
    expect(filesProblem([torrent(), new File(["x"], "a.txt")])).toMatch(
      /a\.txt/,
    );
    expect(
      filesProblem([torrent("big.torrent", TORRENT_MAX_BYTES + 1)]),
    ).toMatch(/16 MB/);
  });
});

describe("adder", () => {
  it("says how far a batch got", async () => {
    let n = 0;
    const a = createAdder({
      addUrl: async () => undefined,
      addFile: async () => {
        if (++n === 3) throw new Error("not valid");
      },
      paused: () => null,
    });
    expect(
      await a.add({
        kind: "files",
        files: [
          torrent("1.torrent"),
          torrent("2.torrent"),
          torrent("3.torrent"),
        ],
      }),
    ).toBe(false);
    expect(a.getSnapshot().error).toBe("Added 2 of 3. 3.torrent: not valid");
  });
});

describe("the /add page", () => {
  let now = 1_000_000;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks first, ignores an immediate press, then sends the magnet as is", async () => {
    const { posts } = server();
    const router = open(`/add?uri=${encodeURIComponent(MAGNET)}`);
    expect(
      await screen.findByRole("heading", { name: "Add this torrent?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Big Buck+Bunny")).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add torrent" });
    // Focus starts on Cancel, not Add.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    expect(posts).toEqual([]);
    fireEvent.click(add);
    await act(async () => undefined);
    expect(posts).toEqual([]);
    now += 600;
    fireEvent.click(add);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/transfers"),
    );
    expect(posts).toEqual([
      { type: "application/json", body: { url: MAGNET } },
    ]);
    // Focus lands on the page heading.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Transfers"),
    );
  });

  it("shows the hash when there is no name, and moves Cancel → Add with Up", async () => {
    server();
    open(`/add?uri=${encodeURIComponent(`magnet:?xt=urn:btih:${HASH}`)}`);
    expect(await screen.findByText(HASH)).toBeInTheDocument();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const ev = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      cancelable: true,
    });
    handleNavKey(ev, () => undefined);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add torrent" }),
    );
  });

  it("keeps a raw + in the link as sent by the browser", async () => {
    const { posts } = server();
    const raw = `magnet:?xt=urn:btih:${HASH}&dn=a+b`;
    const router = open(`/add?uri=${raw.replace("?", "%3F").replace(/&/g, "%26")}`);
    const add = await screen.findByRole("button", { name: "Add torrent" });
    now += 600;
    fireEvent.click(add);
    await waitFor(() => expect(router.state.location.pathname).toBe("/transfers"));
    // URLSearchParams turns the raw + into a space; that is what is sent and
    // what librqbit reads as the name too.
    expect(posts).toEqual([{ type: "application/json", body: { url: raw.replace("a+b", "a b") } }]);
  });

  it("ignores a held key's auto-repeat on Add", async () => {
    server();
    open(`/add?uri=${encodeURIComponent(MAGNET)}`);
    const add = await screen.findByRole("button", { name: "Add torrent" });
    now += 600;
    expect(fireEvent.keyDown(add, { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(add, { key: "Enter" })).toBe(true);
  });

  it("explains a bad link", async () => {
    server();
    open("/add?uri=javascript%3Aalert(1)");
    expect(
      await screen.findByRole("heading", { name: "That isn't a magnet link" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add torrent" }),
    ).not.toBeInTheDocument();
  });
});

describe("paste, drop and Open .torrent", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const paste = (target: Element, text: string, files: File[] = []) =>
    fireEvent.paste(target, {
      clipboardData: {
        getData: (t: string) => (t === "text/plain" ? text : ""),
        files,
        types: ["text/plain"],
      },
    });

  it("adds a magnet pasted outside a text field", async () => {
    const { posts } = server();
    const router = open("/files");
    await screen.findByRole("heading", { name: "Files" });
    paste(document.body, MAGNET);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/transfers"),
    );
    expect(posts).toEqual([
      { type: "application/json", body: { url: MAGNET } },
    ]);
  });

  it("leaves pastes into the search box and ordinary text alone", async () => {
    const { posts } = server();
    open("/files");
    const search = await screen.findByRole("searchbox", {
      name: "Search files",
    });
    search.focus();
    paste(search, MAGNET);
    paste(document.body, "hello world");
    await act(async () => undefined);
    expect(posts).toEqual([]);
  });

  it("adds a pasted .torrent file", async () => {
    const { posts } = server();
    open("/files");
    await screen.findByRole("heading", { name: "Files" });
    const f = torrent();
    paste(document.body, "", [f]);
    await waitFor(() =>
      expect(posts).toEqual([{ type: "application/x-bittorrent", body: f }]),
    );
  });

  it("sends nothing while stash is restarting and says why", async () => {
    const { posts } = server({ paused: true });
    open("/files");
    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect(add).toHaveAttribute("aria-disabled", "true"));
    paste(document.body, MAGNET);
    expect(await screen.findByRole("alert")).toHaveTextContent(/restarting/);
    expect(posts).toEqual([]);
  });

  const files = (list: File[]) => ({
    types: ["Files"],
    files: list,
    getData: () => "",
    dropEffect: "none",
  });

  it("drops .torrent files, keeping the browser from opening them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { posts } = server();
    open("/files");
    await screen.findByRole("heading", { name: "Files" });
    const over = fireEvent.dragOver(window, { dataTransfer: files([]) });
    expect(over).toBe(false); // default prevented
    expect(screen.getByTestId("drop-overlay")).toBeInTheDocument();
    const f = torrent();
    expect(fireEvent.drop(window, { dataTransfer: files([f]) })).toBe(false);
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(posts).toEqual([{ type: "application/x-bittorrent", body: f }]),
    );
  });

  it("refuses a mixed batch without sending any, and hides the overlay when the drag goes away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { posts } = server();
    open("/files");
    await screen.findByRole("heading", { name: "Files" });
    fireEvent.dragOver(window, { dataTransfer: files([]) });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
    fireEvent.drop(window, {
      dataTransfer: files([torrent(), new File(["x"], "notes.txt")]),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/notes\.txt/);
    expect(posts).toEqual([]);
  });

  it("keeps the browser from opening a dropped file even while paused", async () => {
    const { posts } = server({ paused: true });
    open("/files");
    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect(add).toHaveAttribute("aria-disabled", "true"));
    expect(fireEvent.dragOver(window, { dataTransfer: files([]) })).toBe(false);
    expect(fireEvent.drop(window, { dataTransfer: files([torrent()]) })).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent(/restarting/);
    expect(posts).toEqual([]);
  });

  const links = (text: string) => ({
    types: ["text/uri-list"],
    files: [],
    getData: (t: string) => (t === "text/uri-list" ? `# comment\r\n${text}` : ""),
  });

  it("adds a magnet link dropped from another app, and refuses other links", async () => {
    const { posts } = server();
    const router = open("/files");
    await screen.findByRole("heading", { name: "Files" });
    fireEvent.drop(window, { dataTransfer: links("https://example.com/page") });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only \.torrent files and magnet links/);
    fireEvent.drop(window, { dataTransfer: links(MAGNET) });
    await waitFor(() => expect(router.state.location.pathname).toBe("/transfers"));
    expect(posts).toEqual([{ type: "application/json", body: { url: MAGNET } }]);
  });

  it("shows no overlay for drags that start in the page", async () => {
    server();
    open("/files");
    await screen.findByRole("heading", { name: "Files" });
    fireEvent.dragStart(document.body);
    expect(
      fireEvent.dragOver(window, {
        dataTransfer: {
          types: ["text/uri-list"],
          files: [],
          getData: () => "",
        },
      }),
    ).toBe(true);
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
    fireEvent.dragEnd(document.body);
  });

  it("Open .torrent sends the chosen file, also when the same file is chosen twice", async () => {
    const { posts } = server();
    open("/transfers");
    await screen.findByRole("button", { name: "Open .torrent" });
    const input = screen.getByTestId<HTMLInputElement>("torrent-input");
    const f = torrent();
    await userEvent.upload(input, f);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(input.value).toBe("");
    await userEvent.upload(input, f);
    await waitFor(() => expect(posts).toHaveLength(2));
  });

  it("offers the magnet handler only where the browser supports it", async () => {
    server();
    open("/transfers");
    await screen.findByRole("button", { name: "Open .torrent" });
    expect(
      screen.queryByRole("button", { name: /magnet links/ }),
    ).not.toBeInTheDocument();
  });

  it("registers the magnet handler and says to check the address bar", async () => {
    server();
    const register = vi.fn();
    Object.defineProperty(navigator, "registerProtocolHandler", {
      value: register,
      configurable: true,
    });
    vi.stubGlobal("isSecureContext", true);
    open("/transfers");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Open magnet links with stash",
      }),
    );
    expect(register).toHaveBeenCalledWith(
      "magnet",
      `${location.origin}/add?uri=%s`,
    );
    expect(
      screen.getByRole("button", { name: /check the address bar/ }),
    ).toBeInTheDocument();
    Reflect.deleteProperty(navigator, "registerProtocolHandler");
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });
});
