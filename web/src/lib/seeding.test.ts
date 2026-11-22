import { describe, expect, it } from "vitest";
import { parseSeedingPolicy, parseTransfer, parseSettings, type SeedingPolicy, type Transfer } from "./api";
import { describePolicy, draftFrom, parseDecimal, policyFromDraft, samePolicy, stateLabel } from "./seeding";

describe("seeding policy parsing", () => {
  it.each([
    [{ mode: "stop" }, { mode: "stop" }],
    [{ mode: "forever" }, { mode: "forever" }],
    [{ mode: "ratio", ratio: 1.5 }, { mode: "ratio", ratio: 1.5 }],
    [{ mode: "time", minutes: 90 }, { mode: "time", minutes: 90 }],
    [{ mode: "ratio" }, null],
    [{ mode: "ratio", ratio: 0 }, null],
    [{ mode: "time", minutes: 1.5 }, null],
    [{ mode: "stop", ratio: 2 }, { mode: "stop" }],
    [{ mode: "nope" }, null],
    ["stop", null],
  ])("%j → %j", (input, out) => {
    expect(parseSeedingPolicy(input)).toEqual(out);
  });

  it("settings require a valid seeding value", () => {
    const base = {
      vpn: "strict", vpn_interface: null, vpn_from: "default", blocklist: true, blocklist_source: null,
      blocklist_from: "default",
      blocklist_status: { source: null, updated_at: null, ranges: null, in_use: false, fetching: false, error: null },
      listen_port: null, restart_pending: false, boot_id: "b", seeding_from: "default",
    };
    expect(parseSettings({ ...base, seeding: { mode: "stop" } }).seeding).toEqual({ mode: "stop" });
    expect(() => parseSettings(base)).toThrow("unexpected settings");
    expect(() => parseSettings({ ...base, seeding: { mode: "ratio", ratio: "x" } })).toThrow();
  });

  it("a malformed transfer seeding keeps the transfer", () => {
    const t = parseTransfer({ id: 1, info_hash: "aa", name: "x", stats: null, seeding: { keep: "yes" } });
    expect(t).not.toBeNull();
    expect(t?.seeding).toBeNull();
  });
});

describe("draft", () => {
  it("parses decimals with a comma", () => {
    expect(parseDecimal("1,5")).toBe(1.5);
    expect(parseDecimal(" 2 ")).toBe(2);
    expect(parseDecimal("1.")).toBeNull();
    expect(parseDecimal("-1")).toBeNull();
    expect(parseDecimal("1e3")).toBeNull();
  });

  it("normalises hours to minutes and compares by value", () => {
    const r = policyFromDraft({ mode: "time", ratio: "1", hours: "1.5" });
    expect(r).toEqual({ ok: true, policy: { mode: "time", minutes: 90 } });
    expect(policyFromDraft({ mode: "time", ratio: "1", hours: "1.555" }).ok).toBe(false);
    expect(policyFromDraft({ mode: "time", ratio: "1", hours: "0.05" }).ok).toBe(false);
    expect(samePolicy({ mode: "ratio", ratio: 1.5 }, { mode: "ratio", ratio: 1.5 })).toBe(true);
    expect(samePolicy({ mode: "stop" }, { mode: "forever" })).toBe(false);
    expect(draftFrom({ mode: "time", minutes: 1440 }).hours).toBe("24");
    expect(draftFrom({ mode: "stop" })).toEqual({ mode: "stop", ratio: "1", hours: "24" });
  });

  it("describes values that don't fit a field", () => {
    expect(describePolicy({ mode: "time", minutes: 1 })).toBe("For 1 minute after it finishes");
    expect(describePolicy({ mode: "time", minutes: 7 * 1440 })).toBe("For 7 days after it finishes");
  });
});

describe("transfer labels", () => {
  const t = (state: string, finished: boolean, seeding: Partial<NonNullable<Transfer["seeding"]>> | null): Transfer => ({
    id: 1,
    infoHash: "aa",
    name: "x",
    files: null,
    deleted: [],
    stats: {
      state: state as never,
      error: null,
      progressBytes: 1000,
      totalBytes: 1000,
      finished,
      fileProgress: [],
      live: null,
    },
    seeding:
      seeding === null
        ? null
        : { keep: false, uploadedBytes: 0, finishedAt: 1, stoppedByRule: false, stopsAt: null, targetBytes: null, ...seeding },
  });

  it.each([
    [t("paused", true, { stoppedByRule: true }), "Done · not seeding (seeding rule)"],
    [t("paused", true, {}), "Done · paused"],
    [t("paused", false, {}), "Paused"],
    [t("live", true, { keep: true }), "Done · seeding (kept)"],
    [t("live", true, { stopsAt: 1000 + 3 * 3600 }), "Done · seeding, stops in 3 h"],
    [t("live", true, { targetBytes: 1500 }), "Done · seeding until 1.5×"],
    [t("live", true, null), "Done · seeding"],
    [t("live", false, {}), "Downloading"],
  ])("%#: %s", (transfer, label) => {
    expect(stateLabel(transfer, 1000)).toBe(label);
  });
});

describe("round trip", () => {
  it("what is saved is what the form shows after a reload", () => {
    const samples: SeedingPolicy[] = [
      { mode: "stop" },
      { mode: "forever" },
      { mode: "ratio", ratio: 0.1 },
      { mode: "ratio", ratio: 1.5 },
      { mode: "ratio", ratio: 100 },
    ];
    for (const m of [1, 3, 6, 7, 8, 59, 60, 61, 90, 1440, 1441, 7 * 1440, 525_600]) {
      samples.push({ mode: "time", minutes: m });
    }
    for (const p of samples) {
      const r = policyFromDraft(draftFrom(p));
      expect(r, JSON.stringify(p)).toEqual({ ok: true, policy: p });
    }
  });

  it("hours that aren't whole minutes are refused, not rounded", () => {
    for (const h of ["0.11", "0.13", "1.01"]) {
      const r = policyFromDraft({ mode: "time", ratio: "1", hours: h });
      expect(r.ok, h).toBe(false);
    }
    expect(policyFromDraft({ mode: "time", ratio: "1", hours: "1.25" })).toEqual({
      ok: true,
      policy: { mode: "time", minutes: 75 },
    });
  });

  it("refuses a thousands separator and rounds the countdown sensibly", () => {
    expect(parseDecimal("1,000")).toBeNull();
    const tr = (stopsAt: number) =>
      stateLabel(
        {
          id: 1, infoHash: "a", name: "x", files: null, deleted: [],
          stats: { state: "live", error: null, progressBytes: 1, totalBytes: 1, finished: true, fileProgress: [], live: null },
          seeding: { keep: false, uploadedBytes: 0, finishedAt: 1, stoppedByRule: false, stopsAt, targetBytes: null },
        },
        0,
      );
    expect(tr(59.7 * 60)).toBe("Done · seeding, stops in 1 h");
    expect(tr(-100)).toBe("Done · seeding, stops in 1 min");
  });
});
