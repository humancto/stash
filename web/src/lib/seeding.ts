// Seeding rule: form draft, validation, and per-transfer labels.

import { SEEDING_BOUNDS, type SeedingPolicy, type Transfer } from "./api";

export type SeedingMode = SeedingPolicy["mode"];

/** What the form holds: the mode plus the raw text of both fields, so a
 * typed value survives switching radios. */
export interface SeedingDraft {
  mode: SeedingMode;
  ratio: string;
  hours: string;
  /** A saved time that isn't a whole 3-minute step (e.g. 7 minutes from
   * the settings file): kept exactly as long as the field isn't edited. */
  exact?: { text: string; minutes: number };
}

export const DEFAULT_RATIO = "1";
export const DEFAULT_HOURS = "24";

/** Accepts "1.5" and "1,5" (one separator, as a decimal mark). Null for
 * anything else, including "1,000" (a thousands separator, not 1). */
export function parseDecimal(text: string, maxDecimals = 6): number | null {
  const raw = text.trim();
  if (/^\d{1,3},\d{3}$/.test(raw)) return null;
  const t = raw.replace(",", ".");
  if (!new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`).test(t)) return null;
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
  const base = {
    mode: p.mode,
    ratio: p.mode === "ratio" ? String(p.ratio) : DEFAULT_RATIO,
    hours: DEFAULT_HOURS,
  };
  if (p.mode !== "time") return base;
  const fits = minutesToHours(p.minutes);
  if (fits !== null) return { ...base, hours: fits };
  const text = (p.minutes / 60).toFixed(2);
  return { ...base, hours: text, exact: { text, minutes: p.minutes } };
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
      if (d.exact && d.hours.trim() === d.exact.text)
        return { ok: true, policy: { mode: "time", minutes: d.exact.minutes } };
      const h = parseDecimal(d.hours, 2);
      const exact = h === null ? NaN : h * 60;
      const minutes = Math.round(exact);
      const maxHours = SEEDING_BOUNDS.maxMinutes / 60;
      if (h === null || h < 0.1 || minutes > SEEDING_BOUNDS.maxMinutes)
        return {
          ok: false,
          field: "hours",
          error: `Enter hours from 0.1 to ${maxHours}, with at most 2 decimals, for example 24.`,
        };
      // Only values that are whole minutes, so what you save is what you
      // see after a reload (0.11 h would be 6.6 minutes).
      if (Math.abs(exact - minutes) > 1e-9)
        return {
          ok: false,
          field: "hours",
          error: "Use steps of 0.05 hours (3 minutes), for example 1.25.",
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
  const mins = Math.max(1, Math.round(left / 60));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
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
