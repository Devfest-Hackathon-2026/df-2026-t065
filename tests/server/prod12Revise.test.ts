import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import type { MenuModel, ModelCallResult } from "@/server/gemini/vertexClient";
import { sanitizeLogEvent, type LogEvent } from "@/server/log";
import { UsageGuard, jstDayKey } from "@/server/usage/guard";
import { InMemoryUsageStore, assertConsumeResult, type UsageStore } from "@/server/usage/store";
import { blob, fakeJpeg, testUsageGuard } from "./helpers";

/*
 * PR #5 independent audit (REVISE): MAJOR-1 (last clock read vs. model start),
 * MAJOR-2 (invalid clock values), MAJOR-3 (Proxy / prototype / reflection
 * errors in store results and permits), MINOR-1 (timeout sentinel collision).
 * Model, store and clock are test doubles. All model outputs are SYNTHETIC.
 */

const ON: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const GOOD_TEXT = JSON.stringify({
  status: "ok",
  imageIssues: [],
  items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
  menuNotices: [],
});
const okOut = (): ModelCallResult => ({ text: GOOD_TEXT, finishReason: "STOP" });
const transient = () => Object.assign(new Error("unavailable"), { status: 503 });
const LIMITS = (daily: number) => ({ dailyInferenceLimit: daily, ratePerMinute: 60, trustedProxyHops: 0 });

/** 2026-11-07 00:00:00.000 JST */
const MIDNIGHT = Date.UTC(2026, 10, 6, 15, 0, 0);
const DAY = 86_400_000;
/** Latest valid time (ECMAScript Date range): a permit that never expires in these tests. */
const FAR = 8_640_000_000_000_000;
const permitUntil = (validUntilMs: number) => ({ decision: "allowed" as const, validFromMs: 0, validUntilMs });

function request(): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}

/**
 * A clock fixed at `before` until `arm()`; after that, the first `k` reads return
 * 23:59:59.999 and every later read returns 00:00:00.000. Trying every `k` puts
 * the switch to midnight between ANY two clock reads of the implementation —
 * the audit's case is "a validity check passes at .999, a later read (e.g. the
 * timeout computation) sees midnight, and the model is started anyway".
 */
function boundaryClock(k: number, before = MIDNIGHT - 5_000) {
  let armed = false;
  let readsAfterArm = 0;
  let last = before;
  const now = () => {
    if (!armed) last = before;
    else last = readsAfterArm++ < k ? MIDNIGHT - 1 : MIDNIGHT;
    return last;
  };
  return { now, arm: () => void (armed = true), last: () => last };
}

const KS = [1, 2, 3, 4, 5, 6, 7, 8];

/** A model that records the last clock value read before it was started. */
function recordingModel(clock: () => number, behaviour: (n: number) => Promise<ModelCallResult> = async () => okOut()) {
  const startedAt: number[] = [];
  const model: MenuModel = {
    generate: async () => {
      startedAt.push(clock());
      return behaviour(startedAt.length);
    },
  };
  return { model, startedAt };
}

// ---------------------------------------------------------------------------
describe("MAJOR-1: the permit is checked at the very last clock read before model.generate()", () => {
  it.each(KS)("audit repro (switch after read %i): a call never starts with a permit that is expired at its LAST clock read", async (k) => {
    const c = boundaryClock(k);
    const permits: number[] = [];
    const hook: ReserveAttempt = async () => {
      const p = permits.length === 0 ? MIDNIGHT : MIDNIGHT + DAY; // 1st: day D, 2nd: day D+1
      permits.push(p);
      c.arm();
      return permitUntil(p);
    };
    const { model, startedAt } = recordingModel(c.last);
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: hook }, { now: c.now });
    expect(startedAt).toHaveLength(1);
    // The permit in use when the call started must be valid at the last read before it.
    expect(startedAt[0]!).toBeLessThan(permits[permits.length - 1]!);
    if (startedAt[0]! >= MIDNIGHT) expect(out).toMatchObject({ ok: true, reserved: 2, reservationsRolledOver: 1 });
  });

  it.each(KS)("same boundary (switch after read %i) with day D+1 full → no start at/after midnight", async (k) => {
    const c = boundaryClock(k);
    let n = 0;
    const hook: ReserveAttempt = async () => {
      c.arm();
      return ++n === 1 ? permitUntil(MIDNIGHT) : { decision: "limited" };
    };
    const { model, startedAt } = recordingModel(c.last);
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: hook }, { now: c.now });
    for (const at of startedAt) expect(at).toBeLessThan(MIDNIGHT);
    if (startedAt.length === 0) expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "daily_limit_reached", attempts: 0, reserved: 1, reservationsRolledOver: 1 });
  });

  it.each(KS)("same boundary on the RETRY (switch after read %i), day D+1 full → the retry never starts at/after midnight", async (k) => {
    const c = boundaryClock(k);
    let n = 0;
    const hook: ReserveAttempt = async () => {
      n++;
      if (n === 2) c.arm(); // the retry's reservation is the one that crosses midnight
      return n <= 2 ? permitUntil(MIDNIGHT) : { decision: "limited" };
    };
    const { model, startedAt } = recordingModel(c.last, async (j) => {
      if (j === 1) throw transient();
      return okOut();
    });
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: hook }, { now: c.now, sleep: async () => {} });
    for (const at of startedAt) expect(at).toBeLessThan(MIDNIGHT);
    if (startedAt.length === 1) expect(out).toMatchObject({ ok: false, code: "AI_FAILED", failure: "upstream_transient", attempts: 1, limitReason: "retry_daily_limit_reached", reservationsRolledOver: 1 });
  });

  it.each(KS)("same boundary on the RETRY (switch after read %i), day D+1 available → the started retry holds a permit valid at its last read", async (k) => {
    const c = boundaryClock(k);
    const permits: number[] = [];
    const hook: ReserveAttempt = async () => {
      if (permits.length === 1) c.arm();
      const p = permits.length < 2 ? MIDNIGHT : MIDNIGHT + DAY;
      permits.push(p);
      return permitUntil(p);
    };
    const { model, startedAt } = recordingModel(c.last, async (j) => {
      if (j === 1) throw transient();
      return okOut();
    });
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: hook }, { now: c.now, sleep: async () => {} });
    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]!).toBeLessThan(permits[permits.length - 1]!);
    expect(out).toMatchObject({ ok: true, attempts: 2 });
  });

  it("explicit audit sequence: validity read at .999, the NEXT read at 00:00 → the day-D permit is not used", async () => {
    // In the code under audit (4b1ade6) the 4th read after the reservation was the validity
    // check (.999) and the 5th the timeout computation (00:00): k = 4 is the audit's sequence.
    // The invariant must hold for every k (tests above), whatever the implementation's read order.
    const c = boundaryClock(4);
    const permits: number[] = [];
    const hook: ReserveAttempt = async () => {
      const p = permits.length === 0 ? MIDNIGHT : MIDNIGHT + DAY;
      permits.push(p);
      c.arm();
      return permitUntil(p);
    };
    const { model, startedAt } = recordingModel(c.last);
    await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: hook }, { now: c.now });
    expect(startedAt).toHaveLength(1);
    expect(startedAt[0]!).toBeLessThan(permits[permits.length - 1]!);
  });

  it.each(Array.from({ length: 12 }, (_, k) => k))(
    "property (ticking clock, start %i ms before midnight + every read advances 1 ms): a call never starts on a day other than its permit's day",
    async (k) => {
      let t = MIDNIGHT - 1 - k;
      const now = () => t++;
      const base = new InMemoryUsageStore(() => t);
      const keys: string[] = [];
      const store: UsageStore = { kind: "rec", consume: async (key, ...a) => (key.startsWith("daily:") && keys.push(key), base.consume(key, ...a)) };
      const guard = new UsageGuard(store, LIMITS(5), now);
      let lastRead = Number.NaN;
      const clock = () => (lastRead = now());
      const started: { at: number; key: string }[] = [];
      const model: MenuModel = { generate: async () => (started.push({ at: t - 1, key: keys[keys.length - 1]! }), okOut()) };
      await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: (d) => guard.reserveInference(d) }, { now: clock });
      void lastRead;
      for (const s of started) expect(s.key).toBe(`daily:${jstDayKey(s.at)}`);
    },
  );

  it("existing behaviour kept: an exactly-expired permit is invalid, and at most ONE replacement per attempt", async () => {
    const t = MIDNIGHT;
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: async () => permitUntil(t) }, { now: () => t });
    expect(out).toMatchObject({ ok: false, failure: "reservation_expired", attempts: 0, reserved: 2, reservationsRolledOver: 2 });
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("MAJOR-2: invalid clock values fail closed", () => {
  const INVALID = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 8.64e15 + 1];

  it.each(INVALID)("clock becomes %s AFTER the reservation → no model start (AI_DISABLED, clock_invalid), the unit stays counted", async (bad) => {
    let armed = false;
    const now = () => (armed ? bad : 1_000);
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const hook: ReserveAttempt = async () => {
      await null; // the clock breaks after the reservation was confirmed
      armed = true;
      return permitUntil(FAR);
    };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: 9_000, reserveAttempt: hook }, { now });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, reserved: 1, reservationsUnknown: 0 });
  });

  it.each(INVALID)("clock becomes %s during the hook's synchronous part → no model start, the reservation counted as UNKNOWN", async (bad) => {
    let armed = false;
    const now = () => (armed ? bad : 1_000);
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const hook: ReserveAttempt = async () => {
      armed = true; // before the runner could see the answer
      return permitUntil(FAR);
    };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: 9_000, reserveAttempt: hook }, { now });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, reserved: 0, reservationsUnknown: 1 });
  });

  it.each(INVALID)("clock is %s from the start → no reservation, no model start", async (bad) => {
    let hookCalls = 0;
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: async () => (hookCalls++, permitUntil(FAR)) }, { now: () => bad });
    expect(calls).toBe(0);
    expect(hookCalls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, reserved: 0 });
  });

  it.each(INVALID)("clock becomes %s on the RETRY → the first error is kept, no second start", async (bad) => {
    let n = 0;
    let armed = false;
    const now = () => (armed ? bad : 1_000);
    const model: MenuModel = {
      generate: async () => {
        n++;
        armed = true;
        throw transient();
      },
    };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: 9_000, reserveAttempt: async () => permitUntil(FAR) }, { now, sleep: async () => {} });
    expect(n).toBe(1);
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1, limitReason: "retry_clock_invalid" });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 8.64e15 + 1, 1.5])("an invalid deadline %s → AI_DISABLED before any reservation", async (deadlineAt) => {
    let hookCalls = 0;
    const out = await analyzeWithGemini({ generate: async () => okOut() }, CFG, REQ, { requestId: "r", deadlineAt, reserveAttempt: async () => (hookCalls++, permitUntil(FAR)) }, { now: () => 1_000 });
    expect(hookCalls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 8.64e15 + 1, 1.5])("an invalid permit expiry %s → store_error, 0 model starts", async (v) => {
    let calls = 0;
    const out = await analyzeWithGemini({ generate: async () => (calls++, okOut()) }, CFG, REQ, { requestId: "r", reserveAttempt: async () => permitUntil(v) });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reservationsUnknown: 1 });
  });

  it.each(INVALID)("the guard with a clock of %s never calls the store (store_error)", async (bad) => {
    let storeCalls = 0;
    const store: UsageStore = { kind: "count", consume: async () => (storeCalls++, { allowed: true, count: 1 }) };
    const g = new UsageGuard(store, LIMITS(10), () => bad);
    expect(await g.reserveInference(9_000)).toEqual({ decision: "store_error" });
    expect(await g.checkRate("c", 9_000)).toBe("store_error");
    expect(storeCalls).toBe(0);
  });

  it("a clock that goes BACKWARDS between preparation and the start gate → no start (clock_invalid)", async () => {
    let armed = false;
    let t = MIDNIGHT - 1;
    const now = () => (armed ? t-- : MIDNIGHT - 5_000); // every read after the reservation is earlier than the previous one
    let calls = 0;
    const hook: ReserveAttempt = async () => {
      await null;
      armed = true;
      return permitUntil(MIDNIGHT);
    };
    const out = await analyzeWithGemini({ generate: async () => (calls++, okOut()) }, CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: hook }, { now });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, reserved: 1 });
  });

  it("the handler with an invalid clock → AI_DISABLED, 0 model starts", async () => {
    let calls = 0;
    const res = await handleAnalyzeMenu(request(), ON, {
      model: { generate: async () => (calls++, okOut()) },
      config: CFG,
      usage: testUsageGuard(),
      now: () => Number.NaN,
      logger: () => {},
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("MAJOR-3: Proxies, prototypes and reflection errors are refused safely", () => {
  const liar = () =>
    new Proxy(
      { allowed: false, count: 0 },
      {
        getOwnPropertyDescriptor: (t, k) => (k === "allowed" ? { value: true, writable: true, enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k)),
      },
    );
  const throwingKeys = () => new Proxy({ allowed: true, count: 1 }, { ownKeys: () => { throw new Error("SYNTHETIC_SECRET_TOKEN"); } });
  const throwingProto = () => new Proxy({ allowed: true, count: 1 }, { getPrototypeOf: () => { throw new Error("SYNTHETIC_SECRET_TOKEN"); } });
  class Result {
    constructor(
      public allowed: boolean,
      public count: number,
    ) {}
  }

  it.each([
    ["audit repro: a Proxy that reports allowed:false as true via its descriptor trap", liar],
    ["a Proxy whose ownKeys throws", throwingKeys],
    ["a Proxy whose getPrototypeOf throws", throwingProto],
    ["a transparent Proxy (no traps)", () => new Proxy({ allowed: true, count: 1 }, {})],
    ["an object with a custom prototype", () => Object.assign(Object.create({ inherited: 1 }), { allowed: true, count: 1 })],
    ["a class instance", () => new Result(true, 1)],
  ])("consume result: %s → rejected (never allowed), no exception escapes", async (_n, make) => {
    expect(() => assertConsumeResult(make(), 1, 10)).toThrow();
    const g = new UsageGuard({ kind: "bad", consume: async () => make() as never }, LIMITS(10));
    expect(await g.reserveInference()).toEqual({ decision: "store_error" });
    expect(await g.checkRate("c")).toBe("store_error");
  });

  it("consume result: a null-prototype object with valid fields is accepted (policy), a plain literal too", () => {
    const np = Object.assign(Object.create(null), { allowed: true, count: 1 });
    expect(assertConsumeResult(np, 1, 10)).toEqual({ allowed: true, count: 1 });
    expect(assertConsumeResult({ allowed: false, count: 3 }, 1, 10)).toEqual({ allowed: false, count: 3 });
  });

  it("a Proxy store result through the runner: store_error, 0 model starts, counted as unknown", async () => {
    const g = new UsageGuard({ kind: "bad", consume: async () => liar() as never }, LIMITS(10));
    let calls = 0;
    const out = await analyzeWithGemini({ generate: async () => (calls++, okOut()) }, CFG, REQ, { requestId: "r", reserveAttempt: (d) => g.reserveInference(d) });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", reserved: 0, reservationsUnknown: 1 });
  });

  it.each([
    ["a Proxy permit whose ownKeys throws (audit repro: must not reject)", () => new Proxy(permitUntil(FAR), { ownKeys: () => { throw new Error("SYNTHETIC_SECRET_TOKEN"); } })],
    ["a Proxy permit with spoofed descriptors", () => new Proxy({ decision: "limited" }, { getOwnPropertyDescriptor: (t, k) => (k === "decision" ? { value: "allowed", writable: true, enumerable: true, configurable: true } : k === "validUntilMs" ? { value: FAR, writable: true, enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k)), ownKeys: () => ["decision", "validUntilMs"] })],
    ["a transparent Proxy permit", () => new Proxy(permitUntil(FAR), {})],
    ["a permit with a custom prototype", () => Object.assign(Object.create({ x: 1 }), permitUntil(FAR))],
    ["a permit whose decision is a getter", () => Object.defineProperty({ validUntilMs: FAR }, "decision", { enumerable: true, get: () => "allowed" })],
  ])("%s → store_error, 0 model starts, counted as unknown", async (_n, make) => {
    let calls = 0;
    const out = await analyzeWithGemini({ generate: async () => (calls++, okOut()) }, CFG, REQ, { requestId: "r", reserveAttempt: (async () => make()) as unknown as ReserveAttempt });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reservationsUnknown: 1 });
  });

  it("a getter on a permit is never invoked", async () => {
    let n = 0;
    const permit = Object.defineProperty({ decision: "allowed" }, "validUntilMs", { enumerable: true, get: () => (n++, FAR) });
    await analyzeWithGemini({ generate: async () => okOut() }, CFG, REQ, { requestId: "r", reserveAttempt: (async () => permit) as unknown as ReserveAttempt });
    expect(n).toBe(0);
  });

  it("a null-prototype permit is accepted (policy)", async () => {
    const permit = Object.assign(Object.create(null), permitUntil(FAR));
    expect((await analyzeWithGemini({ generate: async () => okOut() }, CFG, REQ, { requestId: "r", reserveAttempt: (async () => permit) as unknown as ReserveAttempt })).ok).toBe(true);
  });

  it("nothing from a rejected Proxy reaches the logs", async () => {
    const logs: LogEvent[] = [];
    await handleAnalyzeMenu(request(), ON, {
      model: { generate: async () => okOut() },
      config: CFG,
      usage: new UsageGuard({ kind: "bad", consume: async () => throwingKeys() as never }, LIMITS(10)),
      logger: (e) => logs.push(e),
    });
    expect(JSON.stringify(logs.map(sanitizeLogEvent))).not.toMatch(/SYNTHETIC/);
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ errorCode: "AI_DISABLED", failure: "usage_store_error" });
  });
});

// ---------------------------------------------------------------------------
describe("MINOR-1: internal timeout sentinels cannot be confused with store values", () => {
  it("a store that returns the string \"timeout\" is a store error, not a timeout", async () => {
    const g = new UsageGuard({ kind: "str", consume: async () => "timeout" as never }, LIMITS(10));
    expect(await g.reserveInference()).toEqual({ decision: "store_error" });
    expect(await g.checkRate("c")).toBe("store_error");
  });

  it("a hook that returns the bare string \"store_timeout\" is a store error, counted as unknown", async () => {
    let calls = 0;
    const out = await analyzeWithGemini({ generate: async () => (calls++, okOut()) }, CFG, REQ, { requestId: "r", reserveAttempt: (async () => "store_timeout") as unknown as ReserveAttempt });
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reservationsUnknown: 1 });
  });
});
