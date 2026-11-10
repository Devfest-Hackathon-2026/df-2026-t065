import { types } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini } from "@/server/gemini/analyzeWithGemini";
import type { MenuModel, ModelCallResult } from "@/server/gemini/vertexClient";
import { UsageGuard, jstDayKey, jstDayRange, type ReservationOutcome } from "@/server/usage/guard";
import { UsageStoreInputError, assertConsumeResult, type ConsumeResult, type UsageStore } from "@/server/usage/store";
import { settleUntrusted } from "@/server/untrusted";
import { fakeJpeg } from "../helpers";
import type { BackendFault } from "./referenceTransactionalStore";

/*
 * COMMON UsageStore CONTRACT (PR-F1, revised after the independent audit).
 *
 * Two registration functions, so that no required check can be skipped silently:
 *  - describeMemoryUsageStoreContract: the in-memory store (one process, no
 *    shared backend). Runs the CORE contract plus memory-specific checks.
 *  - describeSharedUsageStoreContract: any SHARED store (the test-only
 *    reference store today; a Firestore-backed store later). It REQUIRES these
 *    capabilities and FAILS AT REGISTRATION (and again for every environment
 *    created) if one is missing — there is no skip path in this suite:
 *      independent store instances, one shared backend, direct observation of
 *      stored counters, a snapshot of all keys, raw value injection (corruption),
 *      and fault injection (a commit whose response is lost; a contention abort).
 *
 * Safety conditions this contract adopts (they also bind the future Firestore store):
 *  S1 one logical reservation (one consume call) is APPLIED AT MOST ONCE, and
 *     exactly `amount` units when it is applied;
 *  S2 a lost response never leads to UNDER-counting: either the result is
 *     confirmed, or the call fails and the guard counts it as unknown;
 *  S3 when the outcome cannot be confirmed, no model call starts;
 *  S4 contention may fail SAFELY (a structured failure → store_error) — that is
 *     an availability matter, never a safety failure;
 *  S5 no application beyond the limit, whatever the responses look like
 *     (checked on the STORED counter, not only on the responses).
 * Whether a real SDK (e.g. Firestore with maxAttempts: 1) guarantees S1 is NOT
 * established by these tests; it must be shown on that store's own backend.
 *
 * Contract IDs:
 *  C1 input contract · C2 output contract + Promise acceptance (allowed and denied)
 *  C3 limit / denial / amount>1 · C4 key independence
 *  C5 concurrency: SAFETY (S5, contention tolerated) separated from AVAILABILITY (no contention)
 *  C6 corrupted stored data fails closed · C7 lost commit response: S1/S2/S3 on the stored counter
 *  C8 contention: nothing applied, store_error through the guard
 *  C9 guard/runner: permit = exact JST day, late confirmation, no answer (timing + accounting)
 *  C10 stored count above a lowered limit: the unchanged output contract refuses it (store_error)
 *  M1 (memory only) a key whose expiry is reached starts again from zero
 */

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

type BaseEnv = {
  label: string;
  /** A store instance. */
  newStore(): UsageStore;
  now(): number;
  setNow(t: number): void;
};

export type MemoryStoreEnv = BaseEnv & {
  /** Units currently counted for `key` on `store` (may mutate the store; call last). */
  observeUnits(store: UsageStore, key: string): Promise<number>;
};

export type CounterObservation = { exists: false } | { exists: true; raw: unknown };

export type SharedStoreEnv = BaseEnv & {
  backend: {
    observe(key: string): CounterObservation;
    snapshot(): ReadonlyMap<string, unknown>;
    setRaw(key: string, value: unknown): void;
    inject(...faults: BackendFault[]): void;
  };
  /** True only for the store's structured contention failure (nothing applied). */
  isContentionError(e: unknown): boolean;
};

/** Thrown when a shared environment lacks a required capability (fails registration / the test). */
export class MissingCapabilityError extends Error {}

/** Synchronous capability check, run at registration and for every environment created. */
export function assertSharedCapabilities(env: unknown): asserts env is SharedStoreEnv {
  const e = env as Partial<SharedStoreEnv> | null;
  const missing: string[] = [];
  const fn = (v: unknown) => typeof v === "function";
  if (!e || typeof e !== "object") throw new MissingCapabilityError("shared store env: not an object");
  if (typeof e.label !== "string") missing.push("label");
  for (const k of ["newStore", "now", "setNow", "isContentionError"] as const) if (!fn(e[k])) missing.push(k);
  const b = e.backend as Partial<SharedStoreEnv["backend"]> | undefined;
  if (!b || typeof b !== "object") missing.push("backend");
  else for (const k of ["observe", "snapshot", "setRaw", "inject"] as const) if (!fn(b[k])) missing.push(`backend.${k}`);
  if (missing.length > 0) throw new MissingCapabilityError(`shared store env lacks required capabilities: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Strict observation and checkers (exported: the negative controls prove they detect violations)
// ---------------------------------------------------------------------------

export class ContractViolation extends Error {}

/**
 * Units of a stored counter, read strictly. An absent key is 0 ONLY when it may
 * legitimately not exist yet (`mustExist: false`); a key that must exist and is
 * absent, or a value that is not a non-negative safe integer (NaN, ±Infinity,
 * fractional, negative, string, null…), is a violation.
 */
export function storedUnits(obs: CounterObservation, opts: { mustExist: boolean }): number {
  if (!obs.exists) {
    if (opts.mustExist) throw new ContractViolation("stored counter is missing although it must exist");
    return 0;
  }
  const v = obs.raw;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ContractViolation(`stored counter is not a non-negative safe integer: ${String(v)}`);
  return v;
}

export type ConcurrentOutcome = { kind: "allowed"; count: number } | { kind: "denied"; count: number } | { kind: "contention" };

/**
 * Classifies settled concurrent calls. A fulfilled value must satisfy the output
 * contract; a rejection is tolerated ONLY if it is the store's structured
 * contention failure. Anything else is a violation.
 */
export function classifySettled(results: readonly PromiseSettledResult<unknown>[], amount: number, limit: number, isContention: (e: unknown) => boolean): ConcurrentOutcome[] {
  return results.map((r) => {
    if (r.status === "rejected") {
      if (isContention(r.reason)) return { kind: "contention" };
      throw new ContractViolation(`unrelated failure under concurrency: ${String((r.reason as Error)?.name ?? r.reason)}`);
    }
    let v: ConsumeResult;
    try {
      v = assertConsumeResult(r.value, amount, limit);
    } catch {
      throw new ContractViolation("a fulfilled result violates the output contract");
    }
    return v.allowed ? { kind: "allowed", count: v.count } : { kind: "denied", count: v.count };
  });
}

/**
 * C5 SAFETY (S5): allowed units never exceed the limit; allowed counts are distinct;
 * the STORED counter equals exactly the allowed units (denials and contention add
 * nothing) and never exceeds the limit. Contention failures are tolerated.
 */
export function checkConcurrencySafety(outcomes: readonly ConcurrentOutcome[], amount: number, limit: number, storedAfter: number): void {
  const allowed = outcomes.filter((o): o is { kind: "allowed"; count: number } => o.kind === "allowed");
  const units = allowed.length * amount;
  if (units > limit) throw new ContractViolation(`C5 safety: ${units} units allowed with limit ${limit}`);
  if (new Set(allowed.map((o) => o.count)).size !== allowed.length) throw new ContractViolation("C5 safety: two allowed calls report the same count");
  if (storedAfter > limit) throw new ContractViolation(`C5 safety: stored counter ${storedAfter} exceeds limit ${limit}`);
  if (storedAfter !== units) throw new ContractViolation(`C5 safety: stored counter ${storedAfter} ≠ allowed units ${units} (a denial or a failure was applied, or an allowance was not)`);
}

/** One raw entry of a snapshot, compared literally (no conversion of absent / invalid values to 0). */
const entry = (m: ReadonlyMap<string, unknown>, k: string): CounterObservation => (m.has(k) ? { exists: true, raw: m.get(k) } : { exists: false });

/**
 * WHOLE-STATE check (MAJOR-1/2 of the 2nd audit). `before` / `after` are snapshots
 * observed directly on the backend, independently of the store's responses.
 *  - each key in `expected` changed by EXACTLY its delta (read strictly: a key may be
 *    absent before only if it was not created yet; it must exist after a positive
 *    delta; a 0 delta means presence AND raw value are identical);
 *  - every other key is unchanged: no creation, no update, no deletion (raw values
 *    compared with Object.is, so NaN / -0 / objects are not normalised).
 */
export function checkStateDelta(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>, expected: Readonly<Record<string, number>>): void {
  for (const [k, delta] of Object.entries(expected)) {
    if (!Number.isSafeInteger(delta) || delta < 0) throw new ContractViolation(`state: invalid expected delta for ${k}`);
    if (delta === 0) {
      const b = entry(before, k);
      const a = entry(after, k);
      if (b.exists !== a.exists || (b.exists && a.exists && !Object.is(b.raw, a.raw))) throw new ContractViolation(`state: ${k} changed although no unit was applied`);
      if (a.exists) storedUnits(a, { mustExist: true }); // and it must still be a valid counter
      continue;
    }
    const b = storedUnits(entry(before, k), { mustExist: false });
    const a = storedUnits(entry(after, k), { mustExist: true });
    if (a - b !== delta) throw new ContractViolation(`state: ${k} increased by ${a - b}, expected exactly ${delta}`);
  }
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (Object.hasOwn(expected, k)) continue;
    const b = entry(before, k);
    const a = entry(after, k);
    if (!b.exists && a.exists) throw new ContractViolation(`state: an unrelated key was created: ${k}`);
    if (b.exists && !a.exists) throw new ContractViolation(`state: an unrelated key was deleted: ${k}`);
    if (b.exists && a.exists && !Object.is(b.raw, a.raw)) throw new ContractViolation(`state: an unrelated key was updated: ${k}`);
  }
}

/** C7 (S1): the target counter increased by EXACTLY `amount` (units, not commits), and no other key changed. */
export function checkAppliedExactlyOnce(target: string, amount: number, before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): void {
  checkStateDelta(before, after, { [target]: amount });
}

/**
 * C5 on the WHOLE state: the response-level safety (S5) AND the stored state — the
 * target key holds exactly the allowed units more than before, and nothing else
 * changed (a denial or a contention failure writes nothing, anywhere).
 */
export function checkConcurrencyState(outcomes: readonly ConcurrentOutcome[], amount: number, limit: number, target: string, before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): void {
  const allowed = outcomes.filter((o): o is { kind: "allowed"; count: number } => o.kind === "allowed");
  const units = allowed.length * amount;
  const base = storedUnits(entry(before, target), { mustExist: false });
  if (base + units > limit) throw new ContractViolation(`C5 safety: ${base} + ${units} units allowed with limit ${limit}`);
  if (new Set(allowed.map((o) => o.count)).size !== allowed.length) throw new ContractViolation("C5 safety: two allowed calls report the same count");
  const a = entry(after, target);
  if (a.exists) {
    const stored = storedUnits(a, { mustExist: true });
    if (stored > limit) throw new ContractViolation(`C5 safety: stored counter ${stored} exceeds limit ${limit}`);
  }
  checkStateDelta(before, after, { [target]: units });
}

/** C7 at the log level (S2): reserved ≤ consumed ≤ reserved + reservationsUnknown, all safe integers. */
export function checkLogBounds(consumed: number, reserved: number, unknown: number): void {
  for (const [n, v] of [["consumed", consumed], ["reserved", reserved], ["unknown", unknown]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new ContractViolation(`C7: ${n} is not a non-negative safe integer: ${String(v)}`);
  }
  if (consumed < reserved || consumed > reserved + unknown) throw new ContractViolation(`C7: consumed ${consumed} outside [${reserved}, ${reserved + unknown}]`);
}

/**
 * C7 procedure: inject a lost commit response, call once, observe. The call may
 * fail (outcome unknown to the caller) or succeed; either way the target must be
 * applied exactly once by `amount` and nothing else may change.
 */
export async function verifyLostCommitResponse(env: SharedStoreEnv, store: UsageStore, key: string, amount: number, limit: number, expiresAtMs: number): Promise<{ rejected: boolean }> {
  const before = env.backend.snapshot();
  env.backend.inject("commit_lost");
  // Only the STORE CALL is inside try: a resolved answer is validated afterwards, on a
  // separate path, so an invalid success can never be absorbed as "the expected failure".
  let settled: { ok: true; value: unknown } | { ok: false };
  try {
    settled = { ok: true, value: await store.consume(key, amount, limit, expiresAtMs) };
  } catch {
    settled = { ok: false };
  }
  const after = env.backend.snapshot();
  checkAppliedExactlyOnce(key, amount, before, after);
  if (settled.ok) {
    let r: ConsumeResult;
    try {
      r = assertConsumeResult(settled.value, amount, limit);
    } catch {
      throw new ContractViolation("C7: a resolved response violates the output contract");
    }
    // the unit WAS applied: a resolved answer must say so, with the stored count
    if (!r.allowed || r.count !== storedUnits(entry(after, key), { mustExist: true })) throw new ContractViolation("C7: a resolved response disagrees with the stored counter");
  }
  return { rejected: !settled.ok };
}

/**
 * C5 procedure on the WHOLE state (MAJOR-1 of the 2nd audit): seeds unrelated keys,
 * snapshots the backend directly, runs `calls` concurrent consumes spread over
 * `instances`, snapshots again, classifies the settled results and checks
 * checkConcurrencyState. Used by the contract AND by the negative controls.
 */
export async function verifyConcurrentState(
  env: SharedStoreEnv,
  o: { instances: number; calls: number; amount: number; limit: number; faults?: BackendFault[]; presetTarget?: number },
): Promise<ConcurrentOutcome[]> {
  env.setNow(T0);
  env.backend.setRaw("bystander", 7);
  env.backend.setRaw("rate:other:1", 3);
  if (o.presetTarget !== undefined) env.backend.setRaw("k", o.presetTarget);
  const stores = Array.from({ length: o.instances }, () => env.newStore());
  if (o.faults) env.backend.inject(...o.faults);
  const before = env.backend.snapshot();
  const settled = await Promise.allSettled(Array.from({ length: o.calls }, (_, i) => stores[i % o.instances]!.consume("k", o.amount, o.limit, env.now() + DAY)));
  const after = env.backend.snapshot();
  const outcomes = classifySettled(settled, o.amount, o.limit, env.isContentionError);
  checkConcurrencyState(outcomes, o.amount, o.limit, "k", before, after);
  return outcomes;
}

/**
 * C7 through the guard and the runner (MAJOR-2 of the 2nd audit): a lost commit
 * response on the daily reservation. Observed on the WHOLE backend state, before
 * and after, independently of the responses:
 *  - the daily key increased by exactly 1, and nothing else changed (with
 *    `withRate`, the route's per-minute key is the one other allowed change: +1);
 *  - S3: a model call starts only with a reservation the STORE confirmed (starts ≤
 *    confirmed answers, observed on the store's own validated responses);
 *  - S2: the unit is accounted for (reserved ≤ stored ≤ reserved + unknown).
 * `reserve` is the reservation hook (the guard's by default; negative controls
 * replace it with a broken one).
 */
export async function verifyGuardedLostCommit(
  env: SharedStoreEnv,
  opts: { withRate?: boolean; reserve?: (g: UsageGuard, deadlineAt: number) => Promise<ReservationOutcome> } = {},
): Promise<{ out: Awaited<ReturnType<typeof analyzeWithGemini>>; starts: number }> {
  env.setNow(T0);
  const daily = `daily:${jstDayKey(T0)}`;
  const rate = `rate:c:${Math.floor(T0 / 60_000)}`;
  // Independent observation of CONFIRMED daily reservations: the store's own answers,
  // validated here — not the runner's counters (a broken hook could inflate those).
  const inner = env.newStore();
  let confirmed = 0;
  const observed: UsageStore = {
    kind: inner.kind,
    consume: async (key, amount, limit, expiresAtMs) => {
      const r = await inner.consume(key, amount, limit, expiresAtMs);
      if (key === daily) {
        try {
          if (assertConsumeResult(r, amount, limit).allowed) confirmed++;
        } catch {
          /* an invalid answer confirms nothing */
        }
      }
      return r;
    },
  };
  const g = new UsageGuard(observed, LIMITS(10), env.now);
  const before = env.backend.snapshot();
  if (opts.withRate) {
    env.backend.inject("none"); // the rate check commits normally…
    if ((await g.checkRate("c", T0 + 8_000)) !== "allowed") throw new ContractViolation("C7: the rate check was not allowed");
  }
  env.backend.inject("commit_lost"); // …the daily reservation loses its response
  const m = countingModel();
  const reserve = opts.reserve ?? ((guard, d) => guard.reserveInference(d));
  const out = await analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", deadlineAt: T0 + 8_000, reserveAttempt: (d) => reserve(g, d) }, { now: env.now });
  const after = env.backend.snapshot();
  checkStateDelta(before, after, opts.withRate ? { [daily]: 1, [rate]: 1 } : { [daily]: 1 });
  if (m.starts() > confirmed) throw new ContractViolation(`S3: ${m.starts()} model start(s) with ${confirmed} confirmed reservation(s)`);
  checkLogBounds(storedUnits(entry(after, daily), { mustExist: true }), out.reserved, out.reservationsUnknown);
  return { out, starts: m.starts() };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
/** 2026-11-07 12:00 JST */
const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const CFG: GeminiConfig = { project: "p", location: "global", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const LIMITS = (daily: number) => ({ dailyInferenceLimit: daily, ratePerMinute: 60, trustedProxyHops: 0 });
const SYNTHETIC_OK: ModelCallResult = {
  text: JSON.stringify({
    status: "ok",
    imageIssues: [],
    items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
    menuNotices: [],
  }),
  finishReason: "STOP",
};
function countingModel() {
  let starts = 0;
  const model: MenuModel = { generate: async () => (starts++, SYNTHETIC_OK) };
  return { model, starts: () => starts };
}
const exp = (env: BaseEnv) => env.now() + DAY;

// ---------------------------------------------------------------------------
// CORE contract (memory and shared)
// ---------------------------------------------------------------------------

function coreContract(make: () => BaseEnv, observeUnits: (env: BaseEnv, store: UsageStore, key: string) => Promise<number>, isContention: (env: BaseEnv, e: unknown) => boolean): void {
  // C1 --------------------------------------------------------------------
  it.each([
    ["amount 0", 0, 5],
    ["amount negative", -1, 5],
    ["amount fractional", 1.5, 5],
    ["amount NaN", Number.NaN, 5],
    ["amount unsafe", Number.MAX_SAFE_INTEGER + 1, 5],
    ["limit 0", 1, 0],
    ["limit fractional", 1, 2.5],
    ["limit Infinity", 1, Number.POSITIVE_INFINITY],
  ])("C1 input: %s → UsageStoreInputError, nothing counted", async (_n, amount, limit) => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    await expect(s.consume("k", amount, limit, exp(env))).rejects.toBeInstanceOf(UsageStoreInputError);
    expect(await s.consume("k", 1, 5, exp(env))).toEqual({ allowed: true, count: 1 });
  });

  it.each([
    ["in the past", (now: number) => now - 1],
    ["equal to now", (now: number) => now],
    ["NaN", () => Number.NaN],
    ["Infinity", () => Number.POSITIVE_INFINITY],
  ])("C1 input: expiry %s → UsageStoreInputError, nothing counted", async (_n, mk) => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    await expect(s.consume("k", 1, 5, mk(env.now()))).rejects.toBeInstanceOf(UsageStoreInputError);
    expect(await s.consume("k", 1, 5, exp(env))).toEqual({ allowed: true, count: 1 });
  });

  // C2 (MINOR-1: the formal output contract, for allowed AND denied answers) ----
  it.each(["allowed", "denied"] as const)("C2 %s answer: passes the formal output contract and the return value is accepted by settleUntrusted", async (which) => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    if (which === "denied") await s.consume("k", 1, 1, exp(env));
    const ret: unknown = s.consume("k", 1, 1, exp(env));
    if (types.isPromise(ret)) {
      expect(Object.getPrototypeOf(ret)).toBe(Promise.prototype);
      expect(Reflect.ownKeys(ret as object)).toEqual([]);
    }
    const FALLBACK = Symbol("fallback");
    const settled = await settleUntrusted<ConsumeResult | typeof FALLBACK>(ret, (v) => assertConsumeResult(v, 1, 1), FALLBACK);
    expect(settled).toEqual(which === "allowed" ? { allowed: true, count: 1 } : { allowed: false, count: 1 });
  });

  // C3 --------------------------------------------------------------------
  it("C3 allowed until the limit; denials do not increment", async () => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(await s.consume("k", 1, 3, exp(env)));
    expect(seen).toEqual([
      { allowed: true, count: 1 },
      { allowed: true, count: 2 },
      { allowed: true, count: 3 },
      { allowed: false, count: 3 },
      { allowed: false, count: 3 },
    ]);
    expect(await observeUnits(env, s, "k")).toBe(3);
  });

  it("C3 amount > 1 is all-or-nothing", async () => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    expect(await s.consume("k", 2, 3, exp(env))).toEqual({ allowed: true, count: 2 });
    expect(await s.consume("k", 2, 3, exp(env))).toEqual({ allowed: false, count: 2 });
    expect(await s.consume("k", 1, 3, exp(env))).toEqual({ allowed: true, count: 3 });
    expect(await observeUnits(env, s, "k")).toBe(3);
  });

  // C4 --------------------------------------------------------------------
  it("C4 keys are independent (daily / rate keys of different days and windows)", async () => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    const d1 = `daily:${jstDayKey(T0)}`;
    const d2 = `daily:${jstDayKey(T0 + DAY)}`;
    expect(await s.consume(d1, 1, 1, exp(env))).toEqual({ allowed: true, count: 1 });
    expect(await s.consume(d1, 1, 1, exp(env))).toEqual({ allowed: false, count: 1 });
    expect(await s.consume(d2, 1, 1, exp(env) + DAY)).toEqual({ allowed: true, count: 1 });
    expect(await s.consume("rate:unidentified:1", 1, 1, exp(env))).toEqual({ allowed: true, count: 1 });
    expect(await s.consume("rate:unidentified:2", 1, 1, exp(env))).toEqual({ allowed: true, count: 1 });
  });

  // C5 (MAJOR-1: safety separated from availability) ---------------------
  it("C5 AVAILABILITY: without contention, sequential calls use the limit exactly", async () => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    const allowed = [];
    for (let i = 0; i < 15; i++) if ((await s.consume("k", 1, 10, exp(env))).allowed) allowed.push(i);
    expect(allowed).toHaveLength(10);
    expect(await observeUnits(env, s, "k")).toBe(10);
  });

  it.each([1, 2])("C5 SAFETY on ONE instance: 60 concurrent calls (amount %i), limit 10 — stored counter = allowed units ≤ limit", async (amount) => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    const settled = await Promise.allSettled(Array.from({ length: 60 }, () => s.consume("k", amount, 10, exp(env))));
    const outcomes = classifySettled(settled, amount, 10, (e) => isContention(env, e));
    checkConcurrencySafety(outcomes, amount, 10, await observeUnits(env, s, "k"));
  });

  // C9 (MINOR-3: exact permit, timing and accounting) ---------------------
  it("C9 normal path: the permit is EXACTLY the JST day [00:00, next 00:00); the limit stops model starts", async () => {
    const env = make();
    env.setNow(T0);
    const g = new UsageGuard(env.newStore(), LIMITS(1), env.now);
    const day = jstDayRange(T0)!;
    expect(await g.reserveInference(T0 + 5_000)).toEqual({ decision: "allowed", validFromMs: day.startMs, validUntilMs: day.endMs });
    expect(day.endMs - day.startMs).toBe(DAY);
    expect(await g.reserveInference(T0 + 5_000)).toEqual({ decision: "limited" });
    const m = countingModel();
    const out = await analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", deadlineAt: T0 + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: env.now });
    expect(m.starts()).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "daily_limit_reached", reserved: 0, reservationsUnknown: 0 });
  });

  it("C9 a confirmation that arrives after the deadline → allowed_late: counted as reserved (the unit IS stored), 0 model starts", async () => {
    const env = make();
    env.setNow(T0);
    const inner = env.newStore();
    const late: UsageStore = {
      kind: "late",
      consume: async (...a) => {
        const r = await inner.consume(...a);
        env.setNow(env.now() + 6_000); // the answer arrives 1 s after the 5 s deadline
        return r;
      },
    };
    const g = new UsageGuard(late, LIMITS(10), env.now);
    const m = countingModel();
    const out = await analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", deadlineAt: T0 + 5_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: env.now });
    expect(env.now()).toBeGreaterThan(T0 + 5_000);
    expect(m.starts()).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_reservation_late", attempts: 0, reserved: 1, reservationsUnknown: 0 });
    const consumed = await observeUnits(env, inner, `daily:${jstDayKey(T0)}`);
    checkLogBounds(consumed, out.reserved, out.reservationsUnknown);
    expect(consumed).toBe(1);
  });

  // MINOR-1 (2nd audit): the SAFETY of "no answer" is checked on an injected clock and
  // controlled timers (exact boundary, no real-time dependence); a separate real-time
  // integration check uses only generous bounds.
  it("C9 a store that never answers (controlled timers) → not settled 1 ms before the deadline; store_timeout at the deadline; unknown 1; 0 model starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: T0 });
    try {
      const hang: UsageStore = { kind: "hang", consume: () => new Promise<ConsumeResult>(() => {}) };
      const g = new UsageGuard(hang, LIMITS(10), () => Date.now());
      const m = countingModel();
      let done = false;
      const run = analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", deadlineAt: T0 + 1_300, reserveAttempt: (d) => g.reserveInference(d) }, { now: () => Date.now() }).then((o) => ((done = true), o));
      await vi.advanceTimersByTimeAsync(1_299);
      expect(done).toBe(false); // it really waits for the store until the deadline…
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true); // …and gives up AT the deadline, not later
      expect(Date.now()).toBe(T0 + 1_300);
      const out = await run;
      expect(m.starts()).toBe(0);
      expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_timeout", attempts: 0, reserved: 0, reservationsUnknown: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("C9 a store that never answers (real time, integration) → ends after waiting, well within a generous bound; unknown 1; 0 model starts", async () => {
    const hang: UsageStore = { kind: "hang", consume: () => new Promise<ConsumeResult>(() => {}) };
    const g = new UsageGuard(hang, LIMITS(10));
    const m = countingModel();
    const t0 = Date.now();
    const out = await analyzeWithGemini(m.model, { ...CFG, requestDeadlineMs: 1_300 }, REQ, { requestId: "r", reserveAttempt: (d) => g.reserveInference(d) });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1_000); // it did wait (the deadline is 1.3 s)
    expect(elapsed).toBeLessThan(8_000); // generous: a slow CI must not fail a correct store
    expect(m.starts()).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_timeout", attempts: 0, reserved: 0, reservationsUnknown: 1 });
  }, 15_000);

  // C10 -------------------------------------------------------------------
  it("C10 a stored count above the CURRENT limit (limit lowered) is refused by the unchanged output contract → store_error", async () => {
    const env = make();
    env.setNow(T0);
    const s = env.newStore();
    const key = `daily:${jstDayKey(T0)}`;
    for (let i = 0; i < 3; i++) await s.consume(key, 1, 5, exp(env));
    const lowered = await s.consume(key, 1, 2, exp(env));
    expect(lowered).toEqual({ allowed: false, count: 3 });
    expect(() => assertConsumeResult(lowered, 1, 2)).toThrow();
    const g = new UsageGuard(s, LIMITS(2), env.now);
    expect(await g.reserveInference(T0 + 5_000)).toEqual({ decision: "store_error" });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function describeMemoryUsageStoreContract(makeEnv: () => MemoryStoreEnv): void {
  const label = makeEnv().label;
  describe(`UsageStore contract (core + memory) — ${label}`, () => {
    coreContract(
      makeEnv,
      (env, store, key) => (env as MemoryStoreEnv).observeUnits(store, key),
      () => false, // the in-memory store has no contention failure: any rejection is a violation
    );

    // M1 (MINOR-2) ----------------------------------------------------------
    it("M1 a key whose expiry is reached EXACTLY starts again from zero (no stale value at the boundary)", async () => {
      const env = makeEnv();
      env.setNow(T0);
      const s = env.newStore();
      const expiry = T0 + 60_000;
      expect(await s.consume("rate:c:1", 1, 2, expiry)).toEqual({ allowed: true, count: 1 });
      expect(await s.consume("rate:c:1", 1, 2, expiry)).toEqual({ allowed: true, count: 2 });
      env.setNow(expiry - 1);
      expect(await s.consume("rate:c:1", 1, 2, expiry)).toEqual({ allowed: false, count: 2 }); // still valid 1 ms before
      env.setNow(expiry); // exactly at the expiry
      expect(await s.consume("rate:c:1", 1, 2, expiry + 60_000)).toEqual({ allowed: true, count: 1 });
    });
  });
}

export function describeSharedUsageStoreContract(makeEnv: () => SharedStoreEnv): void {
  // MAJOR-3: fail at REGISTRATION if a required capability is missing (no silent skip).
  const probe = makeEnv();
  assertSharedCapabilities(probe);
  const make = (): SharedStoreEnv => {
    const env = makeEnv();
    assertSharedCapabilities(env); // and for every environment created
    return env;
  };
  const sharedObserve = (env: BaseEnv, _s: UsageStore, key: string) => Promise.resolve(storedUnits((env as SharedStoreEnv).backend.observe(key), { mustExist: false }));
  const isContention = (env: BaseEnv, e: unknown) => (env as SharedStoreEnv).isContentionError(e);

  describe(`UsageStore contract (core + shared) — ${probe.label}`, () => {
    coreContract(make, sharedObserve, isContention);

    it("capabilities: independent instances share one observable backend; faults and raw values can be injected", async () => {
      const env = make();
      env.setNow(T0);
      const a = env.newStore();
      const b = env.newStore();
      expect(a).not.toBe(b);
      expect(env.backend.observe("cap")).toEqual({ exists: false });
      expect(await a.consume("cap", 1, 10, exp(env))).toEqual({ allowed: true, count: 1 });
      expect(await b.consume("cap", 1, 10, exp(env))).toEqual({ allowed: true, count: 2 }); // B sees A's write
      expect(storedUnits(env.backend.observe("cap"), { mustExist: true })).toBe(2);
      env.backend.inject("aborted");
      const err = await b.consume("cap", 1, 10, exp(env)).then(() => null, (e: unknown) => e);
      expect(env.isContentionError(err)).toBe(true);
      expect(env.isContentionError(new Error("unrelated"))).toBe(false);
      expect(storedUnits(env.backend.observe("cap"), { mustExist: true })).toBe(2);
      env.backend.setRaw("cap", "SYNTHETIC_CORRUPT");
      await expect(a.consume("cap", 1, 10, exp(env))).rejects.toThrow();
    });

    // C5 shared -------------------------------------------------------------
    // C5 shared: WHOLE-STATE snapshots before/after, observed on the backend (MAJOR-1 of the 2nd audit)
    it.each([
      [1, 1],
      [1, 2],
      [3, 1],
      [3, 2],
    ])("C5 SAFETY on the whole state: %i instance(s), 60 concurrent calls (amount %i), injected contention — target = allowed units ≤ limit, no other key touched", async (n, amount) => {
      const faults = Array.from({ length: 60 }, (_, i): BackendFault => (i % 3 === 1 ? "aborted" : "none"));
      const outcomes = await verifyConcurrentState(make(), { instances: n, calls: 60, amount, limit: 10, faults });
      expect(outcomes.some((o) => o.kind === "contention")).toBe(true);
    });

    it.each([1, 3])("C5 denials AT the limit (%i instance(s), 30 concurrent): every call denied and the whole state unchanged", async (n) => {
      const outcomes = await verifyConcurrentState(make(), { instances: n, calls: 30, amount: 1, limit: 10, presetTarget: 10 });
      expect(outcomes.every((o) => o.kind === "denied")).toBe(true);
    });

    it("C5 AVAILABILITY ACROSS instances: without contention, alternating instances use the limit exactly", async () => {
      const env = make();
      env.setNow(T0);
      const instances = [env.newStore(), env.newStore(), env.newStore()];
      let allowed = 0;
      for (let i = 0; i < 15; i++) if ((await instances[i % 3]!.consume("k", 1, 10, exp(env))).allowed) allowed++;
      expect(allowed).toBe(10);
      expect(storedUnits(env.backend.observe("k"), { mustExist: true })).toBe(10);
    });

    // C6 --------------------------------------------------------------------
    it.each([
      ["a string", "1"],
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["null", null],
      ["an object", { count: 1 }],
    ])("C6 corrupted stored value (%s) → the call fails; never read as allowed; nothing written", async (_n, value) => {
      const env = make();
      env.setNow(T0);
      env.backend.setRaw("k", value);
      const before = env.backend.snapshot();
      await expect(env.newStore().consume("k", 1, 10, exp(env))).rejects.toThrow();
      expect(env.backend.snapshot()).toEqual(before);
    });

    it("C6 through the guard and the runner: corrupted daily counter → store_error, 0 model starts, counted as unknown", async () => {
      const env = make();
      env.setNow(T0);
      env.backend.setRaw(`daily:${jstDayKey(T0)}`, "SYNTHETIC_CORRUPT");
      env.backend.setRaw("bystander", 7);
      const before = env.backend.snapshot();
      const g = new UsageGuard(env.newStore(), LIMITS(10), env.now);
      const m = countingModel();
      const out = await analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", deadlineAt: T0 + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: env.now });
      expect(m.starts()).toBe(0);
      expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", reserved: 0, reservationsUnknown: 1 });
      expect(env.backend.snapshot()).toEqual(before); // the corrupt value is not "repaired" or overwritten
      checkStateDelta(before, env.backend.snapshot(), {});
    });

    // C7 (MAJOR-2) ----------------------------------------------------------
    it.each([
      ["fresh key, amount 1", undefined, 1],
      ["fresh key, amount 2", undefined, 2],
      ["existing count 3, amount 1", 3, 1],
      ["existing count 3, amount 2", 3, 2],
    ])("C7 lost commit response (%s): the target increases by exactly the amount, once; no other key changes", async (_n, existing, amount) => {
      const env = make();
      env.setNow(T0);
      env.backend.setRaw("other", 7);
      if (existing !== undefined) env.backend.setRaw("k", existing);
      await verifyLostCommitResponse(env, env.newStore(), "k", amount, 10, exp(env));
      expect(storedUnits(env.backend.observe("k"), { mustExist: true })).toBe((existing ?? 0) + amount);
      expect(env.backend.observe("other")).toEqual({ exists: true, raw: 7 });
    });

    it("C7 through the guard and the runner: whole state = daily +1 only; no model start; the unknown outcome stays counted", async () => {
      const env = make();
      env.backend.setRaw("bystander", 7);
      env.backend.setRaw(`daily:${jstDayKey(T0 - DAY)}`, 4); // yesterday's counter must not move
      const { out, starts } = await verifyGuardedLostCommit(env);
      expect(starts).toBe(0);
      if (out.reserved === 0) expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reservationsUnknown: 1 });
    });

    it("C7 through the route's guard order (rate check, then daily reservation): only rate +1 and daily +1 change", async () => {
      const env = make();
      env.backend.setRaw("bystander", 7);
      const { out, starts } = await verifyGuardedLostCommit(env, { withRate: true });
      expect(starts).toBe(0);
      if (out.reserved === 0) expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reservationsUnknown: 1 });
    });

    // C8 --------------------------------------------------------------------
    it("C8 contention abort: the call fails with the structured contention error and nothing is applied", async () => {
      const env = make();
      env.setNow(T0);
      const before = env.backend.snapshot();
      env.backend.inject("aborted");
      const err = await env.newStore().consume("k", 1, 10, exp(env)).then(() => null, (e: unknown) => e);
      expect(env.isContentionError(err)).toBe(true);
      expect(env.backend.snapshot()).toEqual(before);
      expect(env.backend.observe("k")).toEqual({ exists: false });
    });

    it("C8 through the guard and the runner: contention → store_error (safe failure), 0 model starts, nothing stored", async () => {
      const env = make();
      env.setNow(T0);
      env.backend.setRaw("bystander", 7);
      const before = env.backend.snapshot();
      env.backend.inject("aborted");
      const g = new UsageGuard(env.newStore(), LIMITS(10), env.now);
      const m = countingModel();
      const out = await analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", deadlineAt: T0 + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: env.now });
      expect(m.starts()).toBe(0);
      expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", reserved: 0, reservationsUnknown: 1 });
      expect(env.backend.observe(`daily:${jstDayKey(T0)}`)).toEqual({ exists: false });
      checkStateDelta(before, env.backend.snapshot(), {});
    });
  });
}
