/*
 * Usage counters (rate limiting and the daily inference cap).
 *
 * A UsageStore must implement `consume` ATOMICALLY: check and increment happen as
 * one operation, so concurrent requests (also on different Cloud Run instances,
 * for a shared store) can never push a counter past its limit. A denied call does
 * not increment. Consumed units are never refunded (a failed or timed-out model
 * call may still be billed).
 *
 * Only an in-memory store exists today, and it is for DEVELOPMENT / TESTS ONLY:
 * each process (each Cloud Run instance) has its own memory, counters are lost on
 * restart, and instances do not see each other. It must never be used as the
 * production cost protection — `readUsageConfig` refuses it when
 * NODE_ENV=production. A shared store (e.g. Firestore) needs approval (D-010).
 */

import { types } from "node:util";

export type ConsumeResult = { allowed: boolean; count: number };

/** Thrown for invalid consume() arguments. The counter is never touched. */
export class UsageStoreInputError extends Error {
  constructor(what: string) {
    super(`invalid usage store input: ${what}`);
    this.name = "UsageStoreInputError";
  }
}

/**
 * Input contract shared by EVERY UsageStore implementation (in-memory today, a
 * shared store such as Firestore later): amount and limit are positive safe
 * integers, expiresAtMs is a finite time in the future. Call it before touching
 * any counter.
 */
export function assertConsumeArgs(amount: number, limit: number, expiresAtMs: number, nowMs: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new UsageStoreInputError("amount");
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new UsageStoreInputError("limit");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) throw new UsageStoreInputError("expiresAtMs");
}

/** Thrown for a consume() result that does not satisfy the output contract. */
export class UsageStoreResultError extends Error {
  constructor() {
    super("invalid usage store result");
    this.name = "UsageStoreResultError";
  }
}

/**
 * OUTPUT contract shared by EVERY UsageStore implementation (PROD-2). The guard
 * applies it to every consume() result before acting on it; a shared store
 * (Firestore) must pass the same check. Anything else is a store error (fail
 * closed — never a truthy/falsy conversion such as `allowed: "false"` → allowed):
 *  - a plain object (prototype `Object.prototype`) or a null-prototype object —
 *    NOT a Proxy (whose traps can fake descriptors or throw), NOT a class
 *    instance or an object with a custom prototype;
 *  - its OWN keys are exactly `allowed` and `count`, both data properties (no
 *    getter is invoked, no extra field is accepted);
 *  - `allowed` is a boolean;
 *  - `count` is a safe integer; when allowed, `amount ≤ count ≤ limit` (the unit
 *    was added and the limit holds); when denied, `0 ≤ count ≤ limit`.
 * Any exception raised while inspecting the value (a throwing or revoked
 * object) is converted into UsageStoreResultError — never propagated as is.
 */
export function assertConsumeResult(value: unknown, amount: number, limit: number): ConsumeResult {
  try {
    return checkConsumeResult(value, amount, limit);
  } catch {
    throw new UsageStoreResultError();
  }
}

function checkConsumeResult(value: unknown, amount: number, limit: number): ConsumeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UsageStoreResultError();
  if (types.isProxy(value)) throw new UsageStoreResultError(); // V8 internal check (Node.js)
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new UsageStoreResultError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("allowed") || !keys.includes("count")) throw new UsageStoreResultError();
  const allowedD = Object.getOwnPropertyDescriptor(value, "allowed");
  const countD = Object.getOwnPropertyDescriptor(value, "count");
  if (!allowedD || !("value" in allowedD) || !countD || !("value" in countD)) throw new UsageStoreResultError();
  const allowed: unknown = allowedD.value;
  const count: unknown = countD.value;
  if (typeof allowed !== "boolean" || typeof count !== "number" || !Number.isSafeInteger(count)) throw new UsageStoreResultError();
  if (count > limit || (allowed ? count < amount : count < 0)) throw new UsageStoreResultError();
  return { allowed, count };
}

export interface UsageStore {
  readonly kind: string;
  /**
   * Atomically adds `amount` to the counter `key` if the result stays ≤ `limit`.
   * `expiresAtMs` tells the store when the counter may be discarded.
   * Throws on store errors (callers fail closed).
   */
  consume(key: string, amount: number, limit: number, expiresAtMs: number): Promise<ConsumeResult>;
}

/** DEVELOPMENT / TEST ONLY. Never a production cost guarantee (see above). */
export class InMemoryUsageStore implements UsageStore {
  readonly kind = "memory";
  private readonly counters = new Map<string, { count: number; expiresAtMs: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(key: string, amount: number, limit: number, expiresAtMs: number): Promise<ConsumeResult> {
    // Everything below runs synchronously (no await), so it is atomic within this process.
    const t = this.now();
    assertConsumeArgs(amount, limit, expiresAtMs, t);
    let entry = this.counters.get(key);
    if (!entry || entry.expiresAtMs <= t) {
      entry = { count: 0, expiresAtMs };
      this.counters.set(key, entry);
    }
    if (entry.count + amount > limit) return { allowed: false, count: entry.count };
    entry.count += amount;
    if (this.counters.size > 10_000) this.sweep(t);
    return { allowed: true, count: entry.count };
  }

  private sweep(t: number): void {
    for (const [k, v] of this.counters) if (v.expiresAtMs <= t) this.counters.delete(k);
  }
}

/** One in-memory store per process, used only outside production. */
let devStore: InMemoryUsageStore | undefined;
export function getDevInMemoryStore(): InMemoryUsageStore {
  devStore ??= new InMemoryUsageStore();
  return devStore;
}
