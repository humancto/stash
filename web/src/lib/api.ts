// Typed client for the stash HTTP API. Shapes follow librqbit 9.1's JSON;
// every response is checked at runtime before the UI trusts it.

export type TorrentState =
  "initializing" | "initializing_paused" | "live" | "paused" | "error";

export interface FileAttrs {
  padding: boolean;
  hidden: boolean;
}

export interface TorrentFile {
  name: string;
  components: string[];
  length: number;
  included: boolean;
  attributes: FileAttrs;
}

export interface LiveStats {
  downloadSpeedMiBps: number;
  downloadSpeedLabel: string;
  peers: number | null;
}

export interface TorrentStats {
  state: TorrentState;
  error: string | null;
  progressBytes: number;
  totalBytes: number;
  finished: boolean;
  fileProgress: number[];
  live: LiveStats | null;
}

export interface TransferSeeding {
  /** "Seed" was pressed: the seeding rule skips this transfer. */
  keep: boolean;
  /** Total uploaded across pauses and restarts. */
  uploadedBytes: number;
  finishedAt: number | null;
  /** Paused by the seeding rule (not by the user). */
  stoppedByRule: boolean;
  /** Time mode: when the rule stops it (unix seconds). */
  stopsAt: number | null;
  /** Ratio mode: bytes to upload before the rule stops it. */
  targetBytes: number | null;
}

export interface Transfer {
  id: number;
  infoHash: string;
  name: string | null;
  files: TorrentFile[] | null;
  stats: TorrentStats | null;
  /** Null from an older stash or a malformed value; never drops the transfer. */
  seeding: TransferSeeding | null;
  /** File ids deleted from this transfer (empty from an older stash). */
  deleted: number[];
}

export type SeedingPolicy =
  | { mode: "stop" }
  | { mode: "forever" }
  | { mode: "ratio"; ratio: number }
  | { mode: "time"; minutes: number };

export const SEEDING_BOUNDS = {
  minRatio: 0.1,
  maxRatio: 100,
  minMinutes: 1,
  maxMinutes: 365 * 24 * 60,
} as const;

export type Verdict = "tunnel" | "exposed" | "offline";

export type Family =
  | { route: false }
  | {
      route: true;
      iface: string | null;
      tunnel: boolean;
      routeConsistent: boolean;
      localIp: string;
      publicIp: string | null;
      country: string | null;
      error: string | null;
    };

export type KillLevel = "strict" | "warn" | "off";
export type KillState =
  | "off"
  | "bound"
  | "blocked"
  | "reconnecting"
  | "exposed"
  | "restart_failed";
export type SettingFrom = "env" | "file" | "default";

export interface KillSwitch {
  level: KillLevel;
  /** Only this interface counts as the VPN (STASH_VPN=<name>). */
  interface: string | null;
  levelFrom: SettingFrom;
  boundTo: string | null;
  state: KillState;
  /** Why stash is stopped and about to restart, if it is. */
  restartReason: RestartReason | null;
  listenPort: number | null;
  acceptingWrites: boolean;
  /** Changes on every (re)start of the stash process. */
  bootId: string;
}

export type RestartReason = "vpn" | "settings";

export interface NetworkReport {
  verdict: Verdict;
  /** Null when talking to a stash without the kill switch. */
  killSwitch: KillSwitch | null;
  /** Unix seconds. */
  checkedAt: number;
  lookupEnabled: boolean;
  ipv4: Family;
  ipv6: Family;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const STATES: readonly TorrentState[] = [
  "initializing",
  "initializing_paused",
  "live",
  "paused",
  "error",
];

function parseFile(v: unknown): TorrentFile | null {
  if (!isObj(v)) return null;
  const name = str(v["name"]);
  const length = num(v["length"]);
  if (name === null || length === null) return null;
  const comps = Array.isArray(v["components"])
    ? v["components"].filter((c): c is string => typeof c === "string")
    : [name];
  const attrs = isObj(v["attributes"]) ? v["attributes"] : {};
  return {
    name,
    components: comps.length ? comps : [name],
    length,
    included: v["included"] !== false,
    attributes: {
      padding: attrs["padding"] === true,
      hidden: attrs["hidden"] === true,
    },
  };
}

function parseLive(v: unknown): LiveStats | null {
  if (!isObj(v)) return null;
  const speed = isObj(v["download_speed"]) ? v["download_speed"] : {};
  const snapshot = isObj(v["snapshot"]) ? v["snapshot"] : {};
  const peerStats = isObj(snapshot["peer_stats"]) ? snapshot["peer_stats"] : {};
  return {
    downloadSpeedMiBps: num(speed["mbps"]) ?? 0,
    downloadSpeedLabel: str(speed["human_readable"]) ?? "",
    peers: num(peerStats["live"]),
  };
}

function parseStats(v: unknown): TorrentStats | null {
  if (!isObj(v)) return null;
  const raw = str(v["state"]);
  const state = STATES.find((s) => s === raw);
  if (!state) return null;
  const fp = Array.isArray(v["file_progress"]) ? v["file_progress"] : [];
  return {
    state,
    error: str(v["error"]),
    progressBytes: num(v["progress_bytes"]) ?? 0,
    totalBytes: num(v["total_bytes"]) ?? 0,
    finished: v["finished"] === true,
    fileProgress: fp.map((n) => num(n) ?? 0),
    live: parseLive(v["live"]),
  };
}

export function parseTransfer(v: unknown): Transfer | null {
  if (!isObj(v)) return null;
  const id = num(v["id"]);
  const infoHash = str(v["info_hash"]);
  if (id === null || infoHash === null) return null;
  const files = Array.isArray(v["files"])
    ? v["files"].map(parseFile).filter((f): f is TorrentFile => f !== null)
    : null;
  return {
    id,
    infoHash,
    name: str(v["name"]),
    files,
    stats: parseStats(v["stats"]),
    seeding: parseTransferSeeding(v["seeding"]),
    deleted: Array.isArray(v["deleted"])
      ? v["deleted"].map(num).filter((n): n is number => n !== null)
      : [],
  };
}

function parseTransferSeeding(v: unknown): TransferSeeding | null {
  if (!isObj(v)) return null;
  const uploadedBytes = num(v["uploaded_bytes"]);
  if (
    typeof v["keep"] !== "boolean" ||
    typeof v["stopped_by_rule"] !== "boolean" ||
    uploadedBytes === null
  )
    return null;
  return {
    keep: v["keep"],
    uploadedBytes,
    finishedAt: num(v["finished_at"]),
    stoppedByRule: v["stopped_by_rule"],
    stopsAt: num(v["stops_at"]),
    targetBytes: num(v["target_bytes"]),
  };
}

export function parseSeedingPolicy(v: unknown): SeedingPolicy | null {
  if (!isObj(v)) return null;
  switch (v["mode"]) {
    case "stop":
      return { mode: "stop" };
    case "forever":
      return { mode: "forever" };
    case "ratio": {
      const ratio = num(v["ratio"]);
      return ratio !== null &&
        ratio >= SEEDING_BOUNDS.minRatio &&
        ratio <= SEEDING_BOUNDS.maxRatio
        ? { mode: "ratio", ratio }
        : null;
    }
    case "time": {
      const minutes = num(v["minutes"]);
      return minutes !== null &&
        Number.isInteger(minutes) &&
        minutes >= SEEDING_BOUNDS.minMinutes &&
        minutes <= SEEDING_BOUNDS.maxMinutes
        ? { mode: "time", minutes }
        : null;
    }
    default:
      return null;
  }
}

export function parseTransferList(v: unknown): Transfer[] {
  if (!isObj(v) || !Array.isArray(v["torrents"])) {
    throw new ApiError("The server sent an unexpected response.", 0);
  }
  return v["torrents"]
    .map(parseTransfer)
    .filter((t): t is Transfer => t !== null);
}

const VERDICTS: readonly Verdict[] = ["tunnel", "exposed", "offline"];
const LEVELS: readonly KillLevel[] = ["strict", "warn", "off"];
const KILL_STATES: readonly KillState[] = ["off", "bound", "blocked", "reconnecting", "exposed", "restart_failed"];
const FROMS: readonly SettingFrom[] = ["env", "file", "default"];

const REASONS: readonly RestartReason[] = ["vpn", "settings"];

/** Absent (an older stash) → null. Present but malformed or unknown → an
 * error, so the UI shows "Unknown" instead of guessing: failing open here
 * could claim protection that isn't there. */
function parseKillSwitch(v: unknown): KillSwitch | null {
  if (v === undefined || v === null) return null;
  const bad = () =>
    new ApiError("The server sent an unexpected kill switch state.", 0);
  if (!isObj(v)) throw bad();
  const level = LEVELS.find((x) => x === v["level"]);
  const state = KILL_STATES.find((x) => x === v["state"]);
  const levelFrom = FROMS.find((x) => x === v["level_from"]);
  const reasonRaw = v["restart_reason"];
  const restartReason =
    reasonRaw === null || reasonRaw === undefined
      ? null
      : (REASONS.find((x) => x === reasonRaw) ?? undefined);
  const bootId = str(v["boot_id"]);
  if (
    !level ||
    !state ||
    !levelFrom ||
    restartReason === undefined ||
    typeof v["accepting_writes"] !== "boolean" ||
    bootId === null
  )
    throw bad();
  return {
    level,
    interface: str(v["interface"]),
    levelFrom,
    boundTo: str(v["bound_to"]),
    state,
    restartReason,
    listenPort: num(v["listen_port"]),
    acceptingWrites: v["accepting_writes"],
    bootId,
  };
}

export interface BlocklistStatus {
  source: string | null;
  updatedAt: number | null;
  ranges: number | null;
  inUse: boolean;
  fetching: boolean;
  error: string | null;
}

export interface Settings {
  vpn: KillLevel;
  vpnInterface: string | null;
  vpnFrom: SettingFrom;
  blocklist: boolean;
  blocklistSource: string | null;
  blocklistFrom: SettingFrom;
  blocklistStatus: BlocklistStatus;
  listenPort: number | null;
  restartPending: boolean;
  bootId: string;
  seeding: SeedingPolicy;
  seedingFrom: SettingFrom;
}

export function parseSettings(v: unknown): Settings {
  const bad = () => new ApiError("The server sent unexpected settings.", 0);
  if (!isObj(v)) throw bad();
  const vpn = LEVELS.find((x) => x === v["vpn"]);
  const vpnFrom = FROMS.find((x) => x === v["vpn_from"]);
  const blocklistFrom = FROMS.find((x) => x === v["blocklist_from"]);
  const st = v["blocklist_status"];
  const bootId = str(v["boot_id"]);
  const seeding = parseSeedingPolicy(v["seeding"]);
  const seedingFrom = FROMS.find((x) => x === v["seeding_from"]);
  if (
    !vpn ||
    !vpnFrom ||
    !blocklistFrom ||
    typeof v["blocklist"] !== "boolean" ||
    !isObj(st) ||
    bootId === null ||
    !seeding ||
    !seedingFrom
  )
    throw bad();
  return {
    vpn,
    vpnInterface: str(v["vpn_interface"]),
    vpnFrom,
    blocklist: v["blocklist"],
    blocklistSource: str(v["blocklist_source"]),
    blocklistFrom,
    blocklistStatus: {
      source: str(st["source"]),
      updatedAt: num(st["updated_at"]),
      ranges: num(st["ranges"]),
      inUse: st["in_use"] === true,
      fetching: st["fetching"] === true,
      error: str(st["error"]),
    },
    listenPort: num(v["listen_port"]),
    restartPending: v["restart_pending"] === true,
    bootId,
    seeding,
    seedingFrom,
  };
}

function parseFamily(v: unknown): Family {
  if (!isObj(v) || typeof v["route"] !== "boolean")
    throw new ApiError("The server sent an unexpected network report.", 0);
  if (!v["route"]) return { route: false };
  const localIp = str(v["local_ip"]);
  if (localIp === null || typeof v["tunnel"] !== "boolean")
    throw new ApiError("The server sent an unexpected network report.", 0);
  return {
    route: true,
    iface: str(v["interface"]),
    tunnel: v["tunnel"],
    routeConsistent: v["route_consistent"] !== false,
    localIp,
    publicIp: str(v["public_ip"]),
    country: str(v["country"]),
    error: str(v["error"]),
  };
}

export function parseNetwork(v: unknown): NetworkReport {
  const bad = () =>
    new ApiError("The server sent an unexpected network report.", 0);
  if (!isObj(v)) throw bad();
  const verdict = VERDICTS.find((x) => x === v["verdict"]);
  const checkedAt = num(v["checked_at"]);
  if (!verdict || checkedAt === null || typeof v["lookup_enabled"] !== "boolean")
    throw bad();
  return {
    verdict,
    killSwitch: parseKillSwitch(v["kill_switch"]),
    checkedAt,
    lookupEnabled: v["lookup_enabled"],
    ipv4: parseFamily(v["ipv4"]),
    ipv6: parseFamily(v["ipv6"]),
  };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Turns any failed response into a readable message. librqbit errors are
 * JSON with `human_readable`; the guard and axum rejections are plain text. */
async function errorFrom(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let message = text.trim();
  try {
    const body: unknown = JSON.parse(text);
    if (isObj(body))
      message = str(body["human_readable"]) ?? str(body["error"]) ?? message;
  } catch {
    // Not JSON: keep the text.
  }
  return new ApiError(
    message || `${res.status} ${res.statusText}`.trim(),
    res.status,
  );
}

/** The one place requests are made; returns the Response on success. */
async function requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, init);
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await requestRaw(path, init);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

export const api = {
  async list(signal?: AbortSignal): Promise<Transfer[]> {
    return parseTransferList(
      await request("/api/transfers", signal ? { signal } : {}),
    );
  },
  async add(url: string): Promise<void> {
    await request("/api/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
  },
  async pause(id: number): Promise<void> {
    await request(`/api/transfers/${id}/pause`, { method: "POST" });
  },
  async start(id: number): Promise<void> {
    await request(`/api/transfers/${id}/start`, { method: "POST" });
  },
  async remove(id: number): Promise<void> {
    await request(`/api/transfers/${id}`, { method: "DELETE" });
  },
  /** Deletes one file: never downloaded again, removed from disk. */
  async removeFile(id: number, fileId: number): Promise<void> {
    await request(`/api/transfers/${id}/files/${fileId}`, { method: "DELETE" });
  },
  async settings(signal?: AbortSignal): Promise<Settings> {
    return parseSettings(
      await request("/api/settings", signal ? { signal } : {}),
    );
  },
  /** 202 → stash restarts to apply; 200 → applied already. */
  async saveSettings(update: {
    vpn?: KillLevel;
    blocklist?: boolean;
    seeding?: SeedingPolicy;
  }): Promise<{ restart: boolean }> {
    const res = await requestRaw("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    if (res.status !== 200 && res.status !== 202)
      throw new ApiError("The server sent an unexpected response.", res.status);
    return { restart: res.status === 202 };
  },
  async restart(): Promise<void> {
    await request("/api/settings/restart", { method: "POST" });
  },
  async refreshBlocklist(): Promise<void> {
    await request("/api/blocklist/refresh", { method: "POST" });
  },
  async network(
    opts: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<NetworkReport> {
    const qs = opts.refresh ? `?${new URLSearchParams({ refresh: "1" })}` : "";
    return parseNetwork(
      await request(
        `/api/network${qs}`,
        opts.signal ? { signal: opts.signal } : {},
      ),
    );
  },
};

export const streamPath = (tid: number, fid: number) =>
  `/api/transfers/${tid}/files/${fid}`;
