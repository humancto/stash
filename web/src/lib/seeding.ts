// Seeding rule: form draft, validation, and per-transfer labels.

import { SEEDING_BOUNDS, type SeedingPolicy, type Transfer } from "./api";

export type SeedingMode = SeedingPolicy["mode"];

/** What the form holds: the mode plus the raw text of both fields, so a
 * typed value survives switching radios. */
export interface SeedingDraft {
  mode: SeedingMode;
  ratio: string;
  hours: string;
}

export const DEFAULT_RATIO = "1";
export const DEFAULT_HOURS = "24";

/** Accepts "1.5" and "1,5". Null for anything that isn't a plain number. */
export function parseDecimal(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Hours in the form: at most 2 decimals. Null when it can't be shown as
 * a field value (e.g. 1 minute), in which case the UI shows text. */
export function minutesToHours(minutes: number): string | null {
  const h = minutes / 60;
  const rounded = Math.round(h * 100) / 100;
  return Math.abs(rounded * 60 - minutes) < 1e-9 && rounded >= 0.1
    ? String(rounded)
    : null;
}

export function draftFrom(p: SeedingPolicy): SeedingDraft {
  return {
    mode: p.mode,
    ratio: p.mode === "ratio" ? String(p.ratio) : DEFAULT_RATIO,
    hours:
      p.mode === "time"
        ? (minutesToHours(p.minutes) ?? DEFAULT_HOURS)
        : DEFAULT_HOURS,
  };
}

export type DraftResult =
  | { ok: true; policy: SeedingPolicy }
  | { ok: false; field: "ratio" | "hours"; error: string };

/** Turns the draft into a policy, with the server's bounds. */
export function policyFromDraft(d: SeedingDraft): DraftResult {
  switch (d.mode) {
    case "stop":
    case "forever":
      return { ok: true, policy: { mode: d.mode } };
    case "ratio": {
      const r = parseDecimal(d.ratio);
      if (
        r === null ||
        r < SEEDING_BOUNDS.minRatio ||
        r > SEEDING_BOUNDS.maxRatio
      )
        return {
          ok: false,
          field: "ratio",
          error: `Enter a ratio from ${SEEDING_BOUNDS.minRatio} to ${SEEDING_BOUNDS.maxRatio}, for example 1.5.`,
        };
      return { ok: true, policy: { mode: "ratio", ratio: r } };
    }
    case "time": {
      const h = parseDecimal(d.hours);
      const minutes = h === null ? NaN : Math.round(h * 60);
      if (
        h === null ||
        h < 0.1 ||
        minutes > SEEDING_BOUNDS.maxMinutes ||
        !/^\d+([.,]\d{1,2})?$/.test(d.hours.trim())
      )
        return {
          ok: false,
          field: "hours",
          error:
            "Enter hours from 0.1 to 8760, with at most 2 decimals, for example 24.",
        };
      return { ok: true, policy: { mode: "time", minutes } };
    }
  }
}

export function samePolicy(a: SeedingPolicy, b: SeedingPolicy): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "ratio" && b.mode === "ratio") return a.ratio === b.ratio;
  if (a.mode === "time" && b.mode === "time") return a.minutes === b.minutes;
  return true;
}

/** Readable form of a policy, for env-locked values that don't fit a field. */
export function describePolicy(p: SeedingPolicy): string {
  switch (p.mode) {
    case "stop":
      return "Stop when finished";
    case "forever":
      return "Keep seeding";
    case "ratio":
      return `Until it has uploaded ${p.ratio}× its size`;
    case "time": {
      const m = p.minutes;
      const text =
        m % 1440 === 0
          ? `${m / 1440} ${m === 1440 ? "day" : "days"}`
          : m % 60 === 0
            ? `${m / 60} ${m === 60 ? "hour" : "hours"}`
            : `${m} ${m === 1 ? "minute" : "minutes"}`;
      return `For ${text} after it finishes`;
    }
  }
}

function untilText(stopsAt: number, now: number): string {
  const left = Math.max(0, stopsAt - now);
  if (left < 3600) return `${Math.max(1, Math.round(left / 60))} min`;
  if (left < 86400) return `${Math.round(left / 3600)} h`;
  return `${Math.round(left / 86400)} d`;
}

/** The state word for a transfer row, seeding-aware. */
export function stateLabel(t: Transfer, nowSecs = Date.now() / 1000): string {
  const s = t.stats;
  if (!s) return "Starting";
  const seed = t.seeding;
  switch (s.state) {
    case "initializing":
    case "initializing_paused":
      return "Checking files";
    case "paused":
      if (!s.finished) return "Paused";
      return seed?.stoppedByRule
        ? "Done · not seeding (seeding rule)"
        : "Done · paused";
    case "error":
      return s.error ? `Error: ${s.error}` : "Error";
    case "live":
      if (!s.finished) return "Downloading";
      if (seed?.keep) return "Done · seeding (kept)";
      if (seed?.stopsAt != null)
        return `Done · seeding, stops in ${untilText(seed.stopsAt, nowSecs)}`;
      if (seed?.targetBytes != null && s.totalBytes > 0)
        return `Done · seeding until ${(seed.targetBytes / s.totalBytes).toFixed(1).replace(/\.0$/, "")}×`;
      return "Done · seeding";
  }
}
