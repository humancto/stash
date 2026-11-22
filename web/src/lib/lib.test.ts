import { describe, expect, it } from "vitest";
import { parseTransfer, parseTransferList, type Transfer } from "./api";
import { fileStatus, flatten, isDeleted, kindOf, selectFiles, shownFiles, swatch } from "./files";
import { formatBytes, formatEta, formatPercent, formatSpeed, percent } from "./format";
import { averageColor, m3u, vlcUrl } from "./media";

const raw = {
  id: 3,
  info_hash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
  name: "Big Buck Bunny",
  files: [
    { name: "Big Buck Bunny.en.srt", components: ["Big Buck Bunny.en.srt"], length: 140, included: true, attributes: { padding: false, hidden: false } },
    { name: "Big Buck Bunny.mp4", components: ["Big Buck Bunny.mp4"], length: 1000, included: true, attributes: { padding: false, hidden: false } },
    { name: "pad", components: [".pad", "1"], length: 10, included: true, attributes: { padding: true, hidden: false } },
    { name: "extra.txt", components: ["extra.txt"], length: 5, included: false, attributes: { padding: false, hidden: false } },
  ],
  stats: {
    state: "live",
    error: null,
    progress_bytes: 640,
    total_bytes: 1155,
    finished: false,
    file_progress: [140, 500, 0, 0],
    live: { download_speed: { mbps: 8.2, human_readable: "8.20 MiB/s" }, snapshot: { peer_stats: { live: 7 } } },
  },
};

describe("api parsing", () => {
  it("parses a librqbit transfer", () => {
    const t = parseTransfer(raw);
    expect(t?.id).toBe(3);
    expect(t?.files).toHaveLength(4);
    expect(t?.stats?.live?.peers).toBe(7);
    expect(t?.stats?.live?.downloadSpeedMiBps).toBe(8.2);
  });
  it("tolerates missing optional fields and drops invalid entries", () => {
    const list = parseTransferList({ torrents: [{ id: 1, info_hash: "a", name: null }, { nope: true }, null] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1, name: null, files: null, stats: null });
  });
  it("rejects a non-list response", () => {
    expect(() => parseTransferList({ error: "x" })).toThrow();
  });
  it("rejects an unknown state", () => {
    expect(parseTransfer({ ...raw, stats: { ...raw.stats, state: "weird" } })?.stats).toBeNull();
  });
});

describe("file status", () => {
  const t = parseTransfer(raw) as Transfer;
  const files = t.files ?? [];
  it("uses the file's own progress", () => {
    expect(fileStatus(t, 0, files[0]!)).toEqual({ kind: "ready" });
    expect(fileStatus(t, 1, files[1]!)).toEqual({ kind: "streaming", pct: 50 });
    expect(fileStatus(t, 3, files[3]!)).toEqual({ kind: "skipped" });
  });
  it("maps states", () => {
    const with_ = (state: string, extra = {}) => parseTransfer({ ...raw, stats: { ...raw.stats, state, ...extra } }) as Transfer;
    expect(fileStatus(with_("paused"), 1, files[1]!)).toEqual({ kind: "paused", pct: 50 });
    expect(fileStatus(with_("paused"), 0, files[0]!)).toEqual({ kind: "ready" });
    expect(fileStatus(with_("initializing"), 1, files[1]!)).toEqual({ kind: "checking" });
    expect(fileStatus(with_("error", { error: "disk full" }), 1, files[1]!)).toEqual({ kind: "error", message: "disk full" });
  });
});

describe("files list", () => {
  const t1 = parseTransfer(raw) as Transfer;
  const t2 = parseTransfer({ ...raw, id: 9, name: "Sintel", files: [{ ...raw.files[1], name: "Sintel.mkv", components: ["Sintel", "Sintel.mkv"] }] }) as Transfer;
  const all = flatten([t1, t2]);
  it("skips padding and deleted files, newest transfer first", () => {
    expect(all.map((f) => f.name)).toEqual(["Sintel.mkv", "Big Buck Bunny.en.srt", "Big Buck Bunny.mp4"]);
  });
  it("marks a transfer's only remaining file as sole", () => {
    expect(all.map((f) => f.sole)).toEqual([true, false, false]);
    // A hidden sibling doesn't count (the server's last-file rule agrees).
    const hidden = parseTransfer({
      ...raw,
      files: [raw.files[1], { ...raw.files[0], attributes: { padding: false, hidden: true } }],
    }) as Transfer;
    expect(flatten([hidden]).map((f) => [f.name, f.sole])).toEqual([["Big Buck Bunny.mp4", true]]);
    expect(shownFiles(hidden)).toHaveLength(1);
  });
  it("knows which files were deleted", () => {
    const t = parseTransfer({ ...raw, deleted: [1, "x", 3] }) as Transfer;
    expect(t.deleted).toEqual([1, 3]);
    expect(isDeleted(t, 1)).toBe(true);
    expect(isDeleted(t, 0)).toBe(false);
    // excluded counts as deleted even from an older server
    expect(isDeleted(parseTransfer(raw) as Transfer, 3)).toBe(true);
    expect((parseTransfer(raw) as Transfer).deleted).toEqual([]);
  });
  it("filters, searches and sorts", () => {
    expect(selectFiles(all, "video", "", "recent").map((f) => f.name)).toEqual(["Sintel.mkv", "Big Buck Bunny.mp4"]);
    expect(selectFiles(all, "other", "", "recent").map((f) => f.name)).toEqual(["Big Buck Bunny.en.srt"]);
    expect(selectFiles(all, "all", "sintel", "recent")).toHaveLength(1);
    expect(selectFiles(all, "all", "", "size")[0]?.length).toBe(1000);
    expect(selectFiles(all, "all", "", "name")[0]?.name).toBe("Big Buck Bunny.en.srt");
  });
  it("classifies kinds and generates stable swatches", () => {
    expect(kindOf("a.MKV")).toBe("video");
    expect(kindOf("a.flac")).toBe("audio");
    expect(kindOf("noext")).toBe("other");
    expect(swatch("x")).toBe(swatch("x"));
    expect(swatch("x")).not.toBe(swatch("y"));
  });
});

describe("formatting", () => {
  it("formats sizes and speeds (MiB/s)", () => {
    expect(formatBytes(276134947)).toBe("263.3 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatSpeed(8.2)).toBe("8.2 MB/s");
    expect(formatSpeed(0.5)).toBe("512 KB/s");
    expect(formatSpeed(0)).toBe("");
  });
  it("formats percent and eta", () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(5, 0)).toBe(0);
    expect(formatPercent(4.25)).toBe("4.3%");
    expect(formatPercent(99.99)).toBe("100%");
    expect(formatEta(10 * 1024 * 1024 * 60 * 5, 10)).toBe("5 min left");
    expect(formatEta(100, 0)).toBe("");
  });
});

describe("media", () => {
  it("builds a playlist and vlc url", () => {
    expect(m3u("A\nB", "http://h/x")).toBe("#EXTM3U\n#EXTINF:-1,A B\nhttp://h/x\n");
    expect(vlcUrl("http://h/x")).toBe("vlc://http://h/x");
  });
  it("averages bright pixels and ignores black bars", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255, 100, 50, 0, 255]);
    expect(averageColor(data)).toEqual([150, 75, 25]);
    expect(averageColor(new Uint8ClampedArray([0, 0, 0, 255]))).toBeNull();
  });
});
