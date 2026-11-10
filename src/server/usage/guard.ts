import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isValidTimeMs, tryReadTime } from "../time";
import { settleUntrusted } from "../untrusted";
import { PROJECT_ID_PATTERN, getFirestoreUsageStore } from "./firestoreStore";
import { assertConsumeResult, getDevInMemoryStore, type UsageStore } from "./store";

/*
 * Cost and abuse guardrails for the real Gemini path (PR5).
 *
 *  - Kill switch: real Gemini runs only when GEMINI_ENABLED is exactly "true".
 *  - Per-client rate limit: fixed 60-second window.
 *  - Daily inference cap for the whole service: one unit is reserved BEFORE every
 *    model call (the retry included). Units are never refunded.
 *
 * Everything fails CLOSED: a missing/invalid setting, an unsupported store, the
 * in-memory store in production, or a store error → no model call (AI_DISABLED).
 *
 * The daily cap limits the NUMBER of model calls; it is not a strict limit on the
 * bill (token counts vary per image and output). Budget alerts only notify.
 */

export type UsageEnv = {
  NODE_ENV?: string;
  GEMINI_ENABLED?: string;
  USAGE_STORE?: string;
  DAILY_INFERENCE_LIMIT?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  TRUSTED_PROXY_HOPS?: string;
  /** Project of the Firestore usage store (the same variable the Vertex AI client uses). */
  GOOGLE_CLOUD_PROJECT?: string;
  /** Read by the Firestore SDK itself; it redirects every request to an UNAUTHENTICATED emulator. */
  FIRESTORE_EMULATOR_HOST?: string;
};

export type UsageLimits = {
  dailyInferenceLimit: number;
  ratePerMinute: number;
  trustedProxyHops: number;
};

export type UsageConfigResult =
  | { ok: true; store: UsageStore; limits: UsageLimits }
  | { ok: false; failure: "kill_switch_off" | "usage_config_invalid" | "usage_store_unavailable" | "usage_store_error" };

/** Proposed defaults / bounds. DAILY_INFERENCE_LIMIT has no default on purpose. */
export const USAGE_BOUNDS = {
  dailyInferenceLimit: [1, 10_000],
  ratePerMinute: [1, 60],
  trustedProxyHops: [0, 3],
} as const;
export const DEFAULT_RATE_PER_MINUTE = 6;

export type UsageStoreFactory = (env: UsageEnv) => UsageStore;

const DEFAULT_STORES: Record<string, UsageStoreFactory> = {
  memory: getDevInMemoryStore,
  firestore: (env) => getFirestoreUsageStore(env.GOOGLE_CLOUD_PROJECT?.trim() ?? ""),
};

/**
 * PR-F2: the Firestore store is NOT approved for production. S1 (one logical
 * reservation applied at most once) is verified on the real SDK only against a
 * fake gRPC server — not on a real Firestore database, and not for gRPC-level
 * transparent retries. Until that verification is recorded and approved
 * (docs/design/firestore-usage-store.md), production refuses it (fail closed:
 * AI_DISABLED). Changing this requires a reviewed PR with the evidence.
 */
export const FIRESTORE_STORE_PRODUCTION_APPROVED = false;

export function isKillSwitchOn(env: UsageEnv): boolean {
  return env.GEMINI_ENABLED !== "true";
}

/**
 * Reads the guard configuration. `stores` maps USAGE_STORE values to store
 * factories: "memory" (development/test only) and "firestore" (explicit opt-in;
 * refused in production until approved, see FIRESTORE_STORE_PRODUCTION_APPROVED).
 * Anything else, or no value, is refused (fail closed).
 */
export function readUsageConfig(
  env: UsageEnv,
  stores: Record<string, UsageStoreFactory> = DEFAULT_STORES,
): UsageConfigResult {
  if (isKillSwitchOn(env)) return { ok: false, failure: "kill_switch_off" };

  const daily = parseIntIn(env.DAILY_INFERENCE_LIMIT, USAGE_BOUNDS.dailyInferenceLimit);
  const rate = env.RATE_LIMIT_PER_MINUTE === undefined ? DEFAULT_RATE_PER_MINUTE : parseIntIn(env.RATE_LIMIT_PER_MINUTE, USAGE_BOUNDS.ratePerMinute);
  const hops = env.TRUSTED_PROXY_HOPS === undefined ? 0 : parseIntIn(env.TRUSTED_PROXY_HOPS, USAGE_BOUNDS.trustedProxyHops);
  if (daily === null || rate === null || hops === null) return { ok: false, failure: "usage_config_invalid" };

  // Non-zero hops trust X-Forwarded-For entries. That is only safe when the real
  // ingress path is verified to OVERWRITE/normalise the header (a client can put
  // anything to the left of what a proxy appends). Until that is confirmed and
  // approved, production refuses it (fail closed). Development/tests may use it.
  if (hops !== 0 && env.NODE_ENV === "production") return { ok: false, failure: "usage_config_invalid" };

  const storeName = env.USAGE_STORE ?? "";
  const factory = Object.prototype.hasOwnProperty.call(stores, storeName) ? stores[storeName] : undefined;
  if (!factory) return { ok: false, failure: "usage_store_unavailable" };
  // The in-memory store only in an EXPLICIT development or test environment.
  if (storeName === "memory" && env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    return { ok: false, failure: "usage_store_unavailable" };
  }
  if (storeName === "firestore") {
    const devOrTest = env.NODE_ENV === "development" || env.NODE_ENV === "test";
    // The SDK sends every request to FIRESTORE_EMULATOR_HOST without authentication
    // when it is set (it overrides any client setting): never outside development/test.
    if (!devOrTest && (env.FIRESTORE_EMULATOR_HOST ?? "").trim() !== "") return { ok: false, failure: "usage_config_invalid" };
    if (!devOrTest && !FIRESTORE_STORE_PRODUCTION_APPROVED) return { ok: false, failure: "usage_store_unavailable" };
    if (!PROJECT_ID_PATTERN.test(env.GOOGLE_CLOUD_PROJECT?.trim() ?? "")) return { ok: false, failure: "usage_config_invalid" };
    // Rate keys of identified clients carry an UNKEYED hash of the IP address, and a
    // shared store would PERSIST them. Until keyed hashing (HMAC, design §7) exists,
    // the Firestore store only accepts the single shared bucket (TRUSTED_PROXY_HOPS=0).
    if (hops !== 0) return { ok: false, failure: "usage_config_invalid" };
  }
  let store: UsageStore;
  try {
    store = factory(env);
  } catch {
    // A store client that fails to initialise must not become an unhandled exception.
    return { ok: false, failure: "usage_store_error" };
  }
  return { ok: true, store, limits: { dailyInferenceLimit: daily, ratePerMinute: rate, trustedProxyHops: hops } };
}

/** Strict integer within bounds; anything else is invalid (null). */
function parseIntIn(raw: string | undefined, [min, max]: readonly [number, number]): number | null {
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

// ---------------------------------------------------------------------------
// Keys and time windows
// ---------------------------------------------------------------------------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // Asia/Tokyo has no daylight saving time

/** The daily counter resets at 00:00 Japan Standard Time. Returns "YYYY-MM-DD" (JST). */
export function jstDayKey(nowMs: number): string {
  return new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The JST day containing `nowMs` as a key and a half-open range
 * [startMs, endMs). Checked for consistency (exactly 24 h, starts at 00:00 JST,
 * the key matches the range, key format YYYY-MM-DD); undefined if anything is
 * off (fail closed). Asia/Tokyo has no DST, so every day is 24 h.
 */
export function jstDayRange(nowMs: number): { key: string; startMs: number; endMs: number } | undefined {
  if (!isValidTimeMs(nowMs)) return undefined;
  const endMs = jstDayEndMs(nowMs);
  const dayStartMs = endMs - 86_400_000; // 00:00 JST (negative only for 1970-01-01 JST)
  const key = jstDayKey(nowMs);
  const consistent =
    Number.isSafeInteger(dayStartMs) &&
    isValidTimeMs(endMs) &&
    dayStartMs <= nowMs &&
    nowMs < endMs &&
    (dayStartMs + JST_OFFSET_MS) % 86_400_000 === 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(key) &&
    jstDayKey(endMs - 1) === key &&
    (dayStartMs < 0 || jstDayKey(dayStartMs) === key);
  // Times before 0 are invalid clock values anyway, so the range is clamped at 0.
  return consistent ? { key, startMs: Math.max(0, dayStartMs), endMs } : undefined;
}

/** End of the current JST day (epoch ms), used as the counter expiry. */
export function jstDayEndMs(nowMs: number): number {
  const startOfDayJst = Math.floor((nowMs + JST_OFFSET_MS) / 86_400_000) * 86_400_000;
  return startOfDayJst + 86_400_000 - JST_OFFSET_MS;
}

/**
 * Client identifier for rate limiting. The service has no login, so this is a
 * best-effort network identifier, never an identity:
 *  - X-Forwarded-For is client-controllable: anything left of what a proxy
 *    appends is attacker data. Counting entries does NOT prove which entry a
 *    trusted proxy wrote. Using hops = n is only correct if the verified ingress
 *    path appends exactly n entries (or overwrites the header). Production refuses
 *    n > 0 until that is approved (readUsageConfig).
 *  - hops = 0 (default), a missing/short header, or an invalid IP → one shared
 *    "unidentified" bucket (fails safe: everyone shares the limit).
 *  - NAT, mobile carriers and VPNs put many users behind one address.
 * The address is normalised, hashed and never logged.
 */
export function clientKey(req: Request, trustedProxyHops: number): string {
  if (trustedProxyHops < 1) return "unidentified";
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return "unidentified";
  const parts = xff.split(",").map((s) => s.trim());
  if (parts.length < trustedProxyHops) return "unidentified";
  const normalized = normalizeClientIp(parts[parts.length - trustedProxyHops] ?? "");
  if (normalized === null) return "unidentified";
  return "c_" + createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Canonical bucket for an IP address, or null if the value is not a plain IP:
 *  - IPv4: dotted decimal, 4 octets 0–255, no leading zeros → "v4:a.b.c.d"
 *  - IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:xxxx:xxxx, any spelling) → the IPv4 bucket
 *  - other IPv6 (compressed or not, any case) → its /64 prefix "v6:xxxx:xxxx:xxxx:xxxx::/64"
 *  - ports, brackets, zone IDs, whitespace and anything else → null
 */
export function normalizeClientIp(raw: string): string | null {
  if (raw === "" || raw !== raw.trim()) return null;
  const v4 = parseIPv4(raw);
  if (v4) return "v4:" + v4.join(".");
  const v6 = parseIPv6(raw);
  if (!v6) return null;
  const isMapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
  if (isMapped) {
    const [a, b] = [v6[6]!, v6[7]!];
    return "v4:" + [a >> 8, a & 0xff, b >> 8, b & 0xff].join(".");
  }
  return "v6:" + v6.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
}

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null; // no leading zeros (ambiguous octal)
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Returns the 8 16-bit groups, or null. Accepts "::" once and a trailing embedded IPv4. */
function parseIPv6(s: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || isIP(s) !== 6) return null;
  let text = s;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    text = text.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  if (tail.length) nums.splice(6, 2, ...tail);
  return nums;
}

// ---------------------------------------------------------------------------
// Guard operations (bounded by the request's absolute deadline)
// ---------------------------------------------------------------------------

/**
 *  - "store_timeout": the store did not answer before the deadline. The store
 *    operation is NOT cancelled by that (a Promise race only stops waiting): it
 *    may still complete and consume a unit later. Callers must treat the unit as
 *    possibly consumed and must not start a model call.
 *  - "allowed_late": the store CONFIRMED the unit, but only after the deadline.
 *    The unit is consumed (it must be counted as reserved), but it is too late
 *    to act on: callers must not start a model call.
 */
export type GuardDecision = "allowed" | "allowed_late" | "limited" | "store_error" | "store_timeout";

/**
 * Result of a daily reservation (PROD-1). A confirmed unit is charged to ONE JST
 * day and is a permit only for a model call that STARTS within that day:
 * `validFromMs ≤ start < validUntilMs` (00:00 JST of the day, inclusive, to
 * 00:00 JST of the next day, exclusive). The runner checks
 * this immediately before starting the call; an expired permit is never used
 * for the next day (a new reservation on the new day is required, and the old
 * unit stays consumed — a conservative over-count).
 */
export type ReservationOutcome =
  | { decision: "allowed" | "allowed_late"; validFromMs: number; validUntilMs: number }
  | { decision: "limited" | "store_error" | "store_timeout" };

const STORE_WAIT_TIMEOUT: unique symbol = Symbol("usage store wait timeout");
const INVALID_RESULT: unique symbol = Symbol("invalid usage store result");
type ConsumeCheck = { allowed: boolean; count: number } | typeof INVALID_RESULT;

/** Used only when a caller gives no deadline (direct use in tests/tools). */
const FALLBACK_STORE_WAIT_MS = 10_000;

export class UsageGuard {
  constructor(
    private readonly store: UsageStore,
    readonly limits: UsageLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Per-client fixed-window rate limit (counts each request that reaches the AI path). */
  async checkRate(client: string, deadlineAt?: number): Promise<GuardDecision> {
    const t = tryReadTime(this.now);
    if (t === undefined) return "store_error"; // invalid clock: no store call (MAJOR-2)
    const window = Math.floor(t / 60_000);
    return this.bounded(
      () => this.store.consume(`rate:${client}:${window}`, 1, this.limits.ratePerMinute, (window + 1) * 60_000),
      deadlineAt ?? t + FALLBACK_STORE_WAIT_MS,
      this.limits.ratePerMinute,
    );
  }

  /**
   * Reserves ONE model call against the service-wide daily cap. Never refunded.
   * The unit is charged to the JST day of `t`; the returned permit is valid only
   * until that day ends (`validUntilMs` = the same expiry given to the store).
   */
  async reserveInference(deadlineAt?: number): Promise<ReservationOutcome> {
    const t = tryReadTime(this.now);
    if (t === undefined) return { decision: "store_error" }; // invalid clock: no store call (MAJOR-2)
    const day = jstDayRange(t);
    if (!day) return { decision: "store_error" }; // inconsistent day key / range: fail closed
    const decision = await this.bounded(
      () => this.store.consume(`daily:${day.key}`, 1, this.limits.dailyInferenceLimit, day.endMs),
      deadlineAt ?? t + FALLBACK_STORE_WAIT_MS,
      this.limits.dailyInferenceLimit,
    );
    return decision === "allowed" || decision === "allowed_late"
      ? { decision, validFromMs: day.startMs, validUntilMs: day.endMs }
      : { decision };
  }

  private async bounded(op: () => Promise<unknown>, deadlineAt: number, limit: number): Promise<GuardDecision> {
    // MAJOR-2: every time value is validated; an invalid clock or deadline never calls the store.
    if (!isValidTimeMs(deadlineAt)) return "store_error";
    const start = tryReadTime(this.now);
    if (start === undefined) return "store_error";
    if (deadlineAt - start <= 0) return "store_timeout"; // do not even start
    let raw: unknown;
    try {
      raw = op(); // a synchronous throw is a store error, not an unhandled exception
    } catch {
      return "store_error";
    }
    // MAJOR-B: the store's answer is validated in its FIRST fulfillment handler and turned
    // into our own value; the untrusted object never reaches a derived promise. The
    // settled promise never rejects (no monitoring `.catch` needed, no unhandledRejection).
    // PROD-2: the output contract is checked for EVERY store (e.g. `allowed: "false"`
    // is a store error, never a truthy/falsy conversion).
    const settled = settleUntrusted<ConsumeCheck>(raw, (v) => assertConsumeResult(v, 1, limit), INVALID_RESULT);
    // Time left AFTER the store call's synchronous part: it cannot extend the deadline.
    // Nothing left → 0 ms: no extra wait, but an already-settled answer is still observed.
    const afterCall = tryReadTime(this.now);
    if (afterCall === undefined) return "store_error"; // the store was called: outcome unknown
    const remaining = Math.max(0, deadlineAt - afterCall);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // MINOR-1: a private symbol, so a store that returns the string "timeout" is not mistaken for one.
    const timeout = new Promise<typeof STORE_WAIT_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(STORE_WAIT_TIMEOUT), remaining);
    });
    try {
      const r = await Promise.race([settled, timeout]);
      if (r === STORE_WAIT_TIMEOUT) return "store_timeout";
      if (r === INVALID_RESULT) return "store_error"; // rejected or invalid: the unit may or may not be consumed
      // Answered, but after the deadline (e.g. a slow store): too late to act on,
      // but a confirmed unit is reported as such so it is never under-counted.
      const answeredAt = tryReadTime(this.now);
      if (answeredAt === undefined) return "store_error"; // unknown when it answered: never "allowed"
      if (answeredAt > deadlineAt) return r.allowed ? "allowed_late" : "limited";
      return r.allowed ? "allowed" : "limited";
    } catch {
      return "store_error";
    } finally {
      clearTimeout(timer);
    }
  }
}
