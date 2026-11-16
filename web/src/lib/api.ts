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

export interface Transfer {
  id: number;
  infoHash: string;
  name: string | null;
  files: TorrentFile[] | null;
  stats: TorrentStats | null;
}

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

export interface NetworkReport {
  verdict: Verdict;
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
  };
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

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(path, init);
  if (!res.ok) throw await errorFrom(res);
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
