import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "../App";
import type { Transfer } from "../lib/api";
import { handleNavKey, nextInGrid } from "../lib/keys";
import {
  createLibraryStore,
  indexTransfers,
  library as libraryStore,
  episodeLabel,
  episodeName,
  librarySignature,
  parseLibrary,
  playChoice,
  titleColor,
  titleState,
  type Title,
} from "../lib/library";

const q = (resolution: string | null = "1080p") => ({
  resolution,
  languages: [],
});
const libraryBody = {
  titles: [
    {
      key: "film-blade-runner-2049-2017",
      kind: "film",
      title: "Blade Runner 2049",
      year: 2017,
      added: 100,
      hidden: false,
      files: [
        {
          tid: 0,
          fid: 0,
          name: "BR.1080p.mkv",
          size: 100,
          quality: q("1080p"),
        },
        {
          tid: 1,
          fid: 0,
          name: "BR.2160p.mkv",
          size: 100,
          quality: q("2160p"),
        },
      ],
    },
    {
      key: "show-severance",
      kind: "show",
      title: "Severance",
      added: 90,
      hidden: false,
      files: [
        {
          tid: 2,
          fid: 0,
          name: "01 - Good News About Hell.mkv",
          size: 50,
          season: 1,
          episodes: [1],
          quality: q(),
        },
        {
          tid: 2,
          fid: 1,
          name: "02 - Half Loop.mkv",
          size: 50,
          season: 1,
          episodes: [2],
          quality: q(),
        },
        {
          tid: 2,
          fid: 2,
          name: "01 - Hello, Ms. Cobel.mkv",
          size: 50,
          season: 2,
          episodes: [1],
          quality: q(),
        },
      ],
    },
    {
      key: "film-old-thing",
      kind: "film",
      title: "Old Thing",
      added: 10,
      hidden: true,
      files: [
        { tid: 3, fid: 0, name: "Old.Thing.mkv", size: 10, quality: q(null) },
      ],
    },
  ],
  pending: [],
  other_files: 0,
};

const file = (name: string) => ({
  name,
  components: [name],
  length: 100,
  included: true,
  attributes: { padding: false, hidden: false },
});
const stats = (progress: number[], state = "live") => ({
  state,
  error: null,
  progress_bytes: 0,
  total_bytes: 100,
  finished: false,
  file_progress: progress,
  live: null,
});
const transfersBody = {
  torrents: [
    {
      id: 0,
      info_hash: "a",
      name: "BR 1080",
      files: [file("BR.1080p.mkv")],
      stats: stats([100]),
      deleted: [],
    },
    {
      id: 1,
      info_hash: "b",
      name: "BR 2160",
      files: [file("BR.2160p.mkv")],
      stats: stats([40]),
      deleted: [],
    },
    {
      id: 2,
      info_hash: "c",
      name: "Severance",
      files: [file("a.mkv"), file("b.mkv"), file("c.mkv")],
      stats: stats([0, 30, 0]),
      deleted: [],
    },
    {
      id: 3,
      info_hash: "d",
      name: "Old",
      files: [file("Old.Thing.mkv")],
      stats: stats([100]),
      deleted: [],
    },
  ],
};

function server() {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (init?.method) calls.push(`${init.method} ${url}`);
    if (url.startsWith("/api/library") && !init?.method) {
      calls.push(`GET ${url}`);
      return new Response(JSON.stringify(libraryBody));
    }
    if (url.startsWith("/api/network"))
      return new Response("{}", { status: 503 });
    if (init?.method) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(transfersBody));
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

const open = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};

const lib = parseLibrary(libraryBody);
const T = (key: string) => lib.titles.find((t) => t.key === key) as Title;
// Transfers as the UI sees them, through the real parser.
async function parsedTransfers(): Promise<Transfer[]> {
  const { api } = await import("../lib/api");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(transfersBody))),
  );
  const list = await api.list();
  vi.unstubAllGlobals();
  return list;
}

describe("library helpers", () => {
  it("parses titles, dropping bad ones", () => {
    expect(lib.titles.map((t) => t.key)).toEqual([
      "film-blade-runner-2049-2017",
      "show-severance",
      "film-old-thing",
    ]);
    const bad = parseLibrary({
      titles: [
        {
          key: "../etc",
          kind: "film",
          title: "x",
          files: [{ tid: 0, fid: 0, name: "a", size: 1 }],
        },
        {
          key: "film-x",
          kind: "poster",
          title: "x",
          files: [{ tid: 0, fid: 0, name: "a", size: 1 }],
        },
        { key: "film-y", kind: "film", title: "y", files: [] },
      ],
    });
    expect(bad.titles).toEqual([]);
    expect(() => parseLibrary({ nope: 1 })).toThrow();
  });

  it("plays the best ready version, else the furthest download, and the first playable episode", async () => {
    const list = indexTransfers(await parsedTransfers());
    // 1080p is ready; 2160p is only 40% there.
    expect(playChoice(list, T("film-blade-runner-2049-2017"))).toEqual({
      file: T("film-blade-runner-2049-2017").files[0],
      streaming: false,
    });
    // Nothing ready yet: the first episode, streaming as it arrives.
    const show = playChoice(list, T("show-severance"));
    expect(show?.file.episodes).toEqual([1]);
    expect(show?.streaming).toBe(true);
    // An active download wins, noting that another version can play.
    expect(titleState(list, T("film-blade-runner-2049-2017"))).toEqual({
      kind: "streaming",
      pct: 40,
      someReady: true,
    });
    expect(titleState(list, T("show-severance"))).toEqual({
      kind: "streaming",
      pct: 30,
      someReady: false,
    });
  });

  it("names episodes", () => {
    expect(episodeLabel(T("show-severance").files[1]!)).toBe("S01E02");
    expect(episodeName("02 - Half Loop.mkv")).toBe("Half Loop");
    expect(episodeName("Show.S01E02.Half.Loop.1080p.WEB-DL.mkv")).toBe(
      "Half Loop",
    );
    expect(episodeName("Friends.S01E01.mkv")).toBeNull();
    expect(episodeName("[SubsPlease] Frieren - 12 (1080p).mkv")).toBeNull();
  });

  it("gives each title one stable colour outside gold's band", () => {
    const c = titleColor({ key: "film-x" });
    expect(titleColor({ key: "film-x" })).toBe(c);
    for (const key of [
      "a",
      "b",
      "film-dune",
      "show-friends",
      "film-rrr-2022",
      "z",
    ]) {
      const hue = Number(/hsl\((\d+)/.exec(titleColor({ key }))?.[1]);
      expect(hue < 25 || hue >= 85).toBe(true);
    }
  });

  it("refetches only when the transfers that matter change", async () => {
    const fetchLibrary = vi.fn(async () => lib);
    const store = createLibraryStore({ fetchLibrary });
    const list = await parsedTransfers();
    const sig = librarySignature(list);
    store.sync(sig);
    store.sync(sig);
    expect(fetchLibrary).toHaveBeenCalledTimes(1);
    // A magnet's file list arriving changes the signature.
    store.sync(
      librarySignature([...list, { ...list[0]!, id: 9, files: null }]),
    );
    expect(fetchLibrary).toHaveBeenCalledTimes(2);
    await store.refresh();
    expect(fetchLibrary).toHaveBeenCalledTimes(3);
  });
});

describe("nextInGrid", () => {
  // 3 columns, 2 rows, ragged: items 0 1 2 / 3 4
  const r = (col: number, row: number) => ({
    left: col * 100,
    top: row * 150,
    width: 90,
    height: 140,
  });
  const grid = [r(0, 0), r(1, 0), r(2, 0), r(0, 1), r(1, 1)];
  it.each([
    [0, "right", 1],
    [2, "right", null],
    [0, "left", null],
    [1, "down", 4],
    [2, "down", 4],
    [4, "up", 1],
    [3, "up", 0],
    [0, "up", null],
    [4, "down", null],
  ] as const)("from %i %s → %s", (from, dir, want) => {
    expect(nextInGrid(grid, from, dir)).toBe(want);
  });
});

describe("Library page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the spotlight, posters with full names, and hides hidden titles", async () => {
    server();
    open("/");
    expect(
      await screen.findByRole("heading", { name: "Library" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Blade Runner 2049" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Play$/ })).toHaveAttribute(
      "href",
      "/watch/0/0",
    );
    const severance = screen.getAllByRole("link", {
      name: "Severance, show, downloading 30%, playable now",
    });
    // On the Downloading shelf and in the grid.
    expect(severance).toHaveLength(2);
    expect(severance[0]).toHaveAttribute("href", "/title/show-severance");
    expect(
      screen.queryByRole("link", { name: /Old Thing/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hidden (1)" }),
    ).toBeInTheDocument();
  });

  it("filters by type in the URL and searches in place", async () => {
    server();
    const router = open("/?q=sever");
    expect(
      await screen.findByRole("heading", { name: "1 title" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Blade Runner 2049" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search library")).toHaveValue("sever");
    await userEvent.click(screen.getByRole("button", { name: "Films" }));
    expect(router.state.location.search).toContain("type=films");
    expect(await screen.findByText("Nothing matches.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Search files instead" }),
    ).toHaveAttribute("href", "/files?q=sever");
  });

  it("unhides a hidden title", async () => {
    const { calls } = server();
    open("/");
    await userEvent.click(
      await screen.findByRole("button", { name: "Hidden (1)" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Show in Library" }),
    );
    await waitFor(() =>
      expect(calls).toContain("DELETE /api/library/film-old-thing/hide"),
    );
  });
});

describe("Title page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists a show's seasons and episodes, and plays the first playable one", async () => {
    server();
    open("/title/show-severance");
    expect(
      await screen.findByRole("heading", { name: "Severance", level: 1 }),
    ).toBeInTheDocument();
    const play = screen.getByRole("link", { name: "Play S01E01" });
    expect(play).toHaveAttribute("href", "/watch/2/0");
    expect(screen.getByText("Good News About Hell")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Season 2" }));
    expect(
      screen.getByRole("heading", { name: "Season 2" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Hello, Ms. Cobel")).toBeInTheDocument();
  });

  it("opens the player with a way back to the title", async () => {
    server();
    const router = open("/title/show-severance");
    await userEvent.click(
      await screen.findByRole("link", { name: "Play S01E01" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/watch/2/0"),
    );
    expect(
      await screen.findByRole("link", { name: "Severance" }),
    ).toHaveAttribute("href", "/title/show-severance");
  });

  it("hides a title and goes back to the Library", async () => {
    const { calls } = server();
    const router = open("/title/film-blade-runner-2049-2017");
    await userEvent.click(
      await screen.findByRole("button", { name: "Hide from Library" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(calls).toContain(
      "POST /api/library/film-blade-runner-2049-2017/hide",
    );
  });

  it("explains a missing title", async () => {
    server();
    open("/title/film-nope");
    expect(
      await screen.findByRole("heading", {
        name: "This title isn't in the Library",
      }),
    ).toBeInTheDocument();
    await act(async () => undefined);
  });
});

describe("remote and history", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const press = (key: string) => {
    const e = new KeyboardEvent("keydown", { key, cancelable: true });
    handleNavKey(e, () => undefined);
    return e;
  };
  const visibleInJsdom = () =>
    vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);

  it("reaches the toolbar, the spotlight and the posters from the rail", async () => {
    server();
    open("/");
    await screen.findByRole("heading", { name: "Blade Runner 2049" });
    visibleInJsdom();
    within(screen.getByRole("navigation", { name: "Main" }))
      .getByRole("link", { name: "Library" })
      .focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "All" }));
    press("ArrowDown");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /^Play/ }));
    press("ArrowDown");
    expect(document.activeElement?.getAttribute("data-key")).toBe("film-blade-runner-2049-2017");
    expect(document.activeElement?.closest("#shelf-downloading, section")?.getAttribute("aria-labelledby")).toBe(
      "shelf-downloading",
    );
  });

  it("focuses Play on a title page, and Back lands on the poster that opened it", async () => {
    server();
    const router = open("/");
    const poster = (await screen.findAllByRole("link", { name: /^Severance, show/ }))[0]!;
    await userEvent.click(poster);
    await screen.findByRole("heading", { name: "Severance", level: 1 });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Play S01E01" }));
    await userEvent.click(document.querySelector<HTMLElement>(".title-page .back")!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-key")).toBe("show-severance"),
    );
  });

  it("Back from the player returns to the title without a new history entry", async () => {
    server();
    const router = open("/title/show-severance");
    await userEvent.click(await screen.findByRole("link", { name: "Play S01E01" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/watch/2/0"));
    await userEvent.click(await screen.findByRole("link", { name: "Severance" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/show-severance"));
    expect(router.state.historyAction).toBe("POP");
    // The played episode's row has focus again.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-key")).toBe("2:0"));
  });

  it("keeps the season in the URL", async () => {
    server();
    const router = open("/title/show-severance?season=2");
    expect(await screen.findByRole("heading", { name: "Season 2" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Season 1" }));
    expect(router.state.location.search).toBe("?season=1");
  });

  it("ignores unknown filter values", async () => {
    server();
    open("/?type=posters&state=nope&sort=x");
    expect(await screen.findByRole("heading", { name: "All titles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("puts a show with one season ready and one downloading on the Downloading shelf", async () => {
    server();
    open("/?state=ready");
    // Blade Runner: one version ready, one downloading → counts as ready.
    expect(await screen.findByRole("heading", { name: "1 title" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Blade Runner 2049, 2017, film, downloading 40%/ })).toBeInTheDocument();
  });

  it("keeps focus on a season button after choosing it", async () => {
    server();
    open("/title/show-severance");
    await screen.findByRole("heading", { name: "Severance", level: 1 });
    const s2 = screen.getByRole("button", { name: "Season 2" });
    await userEvent.click(s2);
    await screen.findByRole("heading", { name: "Season 2" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Season 2" }));
  });

  it("doesn't pull focus back to the poster when the Library refetches", async () => {
    server();
    open("/");
    const poster = (await screen.findAllByRole("link", { name: /^Severance, show/ }))[0]!;
    await userEvent.click(poster);
    await screen.findByRole("heading", { name: "Severance", level: 1 });
    await userEvent.click(document.querySelector<HTMLElement>(".title-page .back")!);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-key")).toBe("show-severance"));
    const play = screen.getByRole("link", { name: /^Play/ });
    play.focus();
    await act(async () => {
      await libraryStore.refresh();
    });
    expect(document.activeElement).toBe(play);
  });
});
