import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import type { MenuModel, ModelCallResult } from "@/server/gemini/vertexClient";
import { sanitizeLogEvent, type LogEvent } from "@/server/log";
import { UsageGuard, jstDayEndMs, jstDayKey } from "@/server/usage/guard";
import { InMemoryUsageStore, assertConsumeResult, type UsageStore } from "@/server/usage/store";
import { blob, fakeJpeg } from "./helpers";

/*
 * PROD-1 (reservations across the JST day boundary) and PROD-2 (runtime
 * validation of UsageStore results). Model and store are test doubles; the
 * clock is fake. All model outputs are SYNTHETIC.
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

/** 2026-11-07 00:00:00.000 JST */
const MIDNIGHT = Date.UTC(2026, 10, 6, 15, 0, 0);
const DAY_D = "2026-11-06";
const DAY_D1 = "2026-11-07";
const LIMITS = (daily: number) => ({ dailyInferenceLimit: daily, ratePerMinute: 60, trustedProxyHops: 0 });

/** A fake clock, a store that can delay answers on that clock, and a model that records start times. */
function rig(opts: { start: number; daily?: number; delayDaily?: (n: number) => number; model?: (n: number) => Promise<ModelCallResult> }) {
  let t = opts.start;
  const now = () => t;
  const base = new InMemoryUsageStore(now);
  let dailyCalls = 0;
  const keys: string[] = [];
  const store: UsageStore = {
    kind: "clocked",
    consume: async (key, amount, limit, exp) => {
      if (key.startsWith("daily:")) {
        keys.push(key);
        const r = await base.consume(key, amount, limit, exp); // decided at the store's time…
        t += opts.delayDaily?.(++dailyCalls) ?? 0; // …answer arrives later
        return r;
      }
      return base.consume(key, amount, limit, exp);
    },
  };
  const guard = new UsageGuard(store, LIMITS(opts.daily ?? 10), now);
  const starts: number[] = [];
  const model: MenuModel = {
    generate: async () => {
      starts.push(t);
      return (opts.model ?? (async () => okOut()))(starts.length);
    },
  };
  const run = () =>
    analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: (d) => guard.reserveInference(d) }, { now, sleep: async (ms) => void (t += ms) });
  return { now, set: (v: number) => void (t = v), base, guard, store, starts, keys, run };
}

// ---------------------------------------------------------------------------
describe("PROD-1: a reservation is valid only for the JST day it was charged to", () => {
  it("the guard reports the end of the charged day with every confirmed reservation", async () => {
    const r = rig({ start: MIDNIGHT - 100 });
    expect(await r.guard.reserveInference(MIDNIGHT + 5_000)).toEqual({ decision: "allowed", validFromMs: MIDNIGHT - 86_400_000, validUntilMs: MIDNIGHT });
    r.set(MIDNIGHT);
    expect(await r.guard.reserveInference(MIDNIGHT + 5_000)).toEqual({ decision: "allowed", validFromMs: MIDNIGHT, validUntilMs: MIDNIGHT + 86_400_000 });
    expect(jstDayEndMs(MIDNIGHT - 1)).toBe(MIDNIGHT);
    expect(jstDayKey(MIDNIGHT - 1)).toBe(DAY_D);
    expect(jstDayKey(MIDNIGHT)).toBe(DAY_D1);
  });

  it("repro: a day-D reservation confirmed after midnight is NOT used for a day-D+1 start when D+1 is full", async () => {
    const r = rig({ start: MIDNIGHT - 500, daily: 2, delayDaily: () => 600 });
    // Day D+1 is already at its limit.
    await r.base.consume(`daily:${DAY_D1}`, 2, 2, MIDNIGHT + 86_400_000);
    const out = await r.run();
    expect(r.starts).toEqual([]); // no model call on day D+1 beyond its limit
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "daily_limit_reached", attempts: 0, reserved: 1, reservationsRolledOver: 1 });
    expect(r.keys).toEqual([`daily:${DAY_D}`, `daily:${DAY_D1}`]);
  });

  it("a day-D reservation that crosses midnight is replaced by a day-D+1 reservation, then the call starts", async () => {
    const r = rig({ start: MIDNIGHT - 500, daily: 2, delayDaily: (n) => (n === 1 ? 600 : 0) });
    const out = await r.run();
    expect(out).toMatchObject({ ok: true, attempts: 1, reserved: 2, reservationsRolledOver: 1 });
    expect(r.starts).toEqual([MIDNIGHT + 100]);
    // Both units were consumed (conservative over-count on day D, never an under-count on D+1).
    expect(r.keys).toEqual([`daily:${DAY_D}`, `daily:${DAY_D1}`]);
    expect((await r.base.consume(`daily:${DAY_D1}`, 2, 2, MIDNIGHT + 86_400_000)).allowed).toBe(false); // D+1 already holds 1
  });

  it("boundary: confirmed at 23:59:59.999 → the call starts on day D with the day-D unit", async () => {
    const r = rig({ start: MIDNIGHT - 2, delayDaily: () => 1 });
    const out = await r.run();
    expect(out).toMatchObject({ ok: true, reserved: 1, reservationsRolledOver: 0 });
    expect(r.starts).toEqual([MIDNIGHT - 1]);
    expect(r.keys).toEqual([`daily:${DAY_D}`]);
  });

  it("boundary: confirmed exactly at 00:00:00.000 → a day-D+1 unit is required (validity is exclusive)", async () => {
    const r = rig({ start: MIDNIGHT - 1, delayDaily: (n) => (n === 1 ? 1 : 0) });
    const out = await r.run();
    expect(out).toMatchObject({ ok: true, reserved: 2, reservationsRolledOver: 1 });
    expect(r.starts).toEqual([MIDNIGHT]);
    expect(r.keys).toEqual([`daily:${DAY_D}`, `daily:${DAY_D1}`]);
  });

  it("the RETRY obeys the same rule: a retry reservation that crosses midnight is replaced, and refused when D+1 is full", async () => {
    const r = rig({
      start: MIDNIGHT - 1_500,
      daily: 2,
      delayDaily: (n) => (n === 2 ? 1_100 : 0),
      model: async (n) => {
        if (n === 1) throw transient();
        return okOut();
      },
    });
    await r.base.consume(`daily:${DAY_D1}`, 2, 2, MIDNIGHT + 86_400_000); // D+1 full
    const out = await r.run();
    // attempt 1 at D−1.5 s fails; backoff 0.5 s; the retry reservation (made at D−1.0 s) is answered at D+0.1 s
    expect(r.starts).toHaveLength(1);
    expect(r.starts[0]!).toBeLessThan(MIDNIGHT);
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", failure: "upstream_transient", attempts: 1, limitReason: "retry_daily_limit_reached", reservationsRolledOver: 1 });
  });

  it("at most ONE replacement reservation per attempt (a hook whose permits are always expired never calls the model)", async () => {
    const t = MIDNIGHT;
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const hook: ReserveAttempt = async () => ({ decision: "allowed", validFromMs: 0, validUntilMs: t });
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: hook }, { now: () => t });
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "reservation_expired", attempts: 0, reserved: 2, reservationsRolledOver: 2 });
    expect(calls).toBe(0);
  });

  it("parallel: 30 requests around midnight never START more than the limit on either day", async () => {
    let t = MIDNIGHT - 300;
    const now = () => t;
    const base = new InMemoryUsageStore(now);
    let tick = 0;
    const store: UsageStore = {
      kind: "jitter",
      consume: async (key, amount, limit, exp) => {
        const r = await base.consume(key, amount, limit, exp);
        await new Promise((res) => setTimeout(res, (tick++ * 7) % 5)); // interleave
        t += 20; // time passes while answers come back
        return r;
      },
    };
    const daily = 5;
    const guard = new UsageGuard(store, LIMITS(daily), now);
    const startDays: string[] = [];
    const model: MenuModel = {
      generate: async () => {
        startDays.push(jstDayKey(t));
        return okOut();
      },
    };
    await Promise.all(
      Array.from({ length: 30 }, () =>
        analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: t + 60_000, reserveAttempt: (d) => guard.reserveInference(d) }, { now }),
      ),
    );
    const perDay = (d: string) => startDays.filter((x) => x === d).length;
    expect(perDay(DAY_D)).toBeLessThanOrEqual(daily);
    expect(perDay(DAY_D1)).toBeLessThanOrEqual(daily);
    expect(startDays.length).toBeGreaterThan(0);
  });

  it.each([
    ["a legacy string", "allowed"],
    ["allowed without a validity", { decision: "allowed" }],
    ["a NaN validity", { decision: "allowed", validUntilMs: Number.NaN }],
    ["a string validity", { decision: "allowed", validUntilMs: "9999999999999" }],
    ["an unknown decision", { decision: "yes", validUntilMs: 9e12 }],
    ["an extra field", { decision: "allowed", validUntilMs: 9e12, count: 1 }],
    ["null", null],
  ])("the runner fails closed on an invalid reservation outcome (%s): 0 model calls", async (_n, value) => {
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: (async () => value) as unknown as ReserveAttempt });
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reservationsUnknown: 1 });
    expect(calls).toBe(0);
  });

  it("the rollover count is logged as an allow-listed number", async () => {
    const r = rig({ start: MIDNIGHT - 500, daily: 2, delayDaily: (n) => (n === 1 ? 600 : 0) });
    const logs: LogEvent[] = [];
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), ON, {
      model: { generate: async () => okOut() },
      config: CFG,
      usage: r.guard,
      now: r.now,
      logger: (e) => logs.push(e),
    });
    expect(res.status).toBe(200);
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ outcome: "ok", reserved: 2, reservationsRolledOver: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("PROD-2: UsageStore results are validated at run time (fail closed)", () => {
  const bad = (value: unknown): UsageStore => ({ kind: "bad", consume: async () => value as never });

  it("repro: { allowed: \"false\", count: 0 } from the daily reservation → store_error, NO model call", async () => {
    const t = 1_000;
    const g = new UsageGuard(bad({ allowed: "false", count: 0 }), LIMITS(10), () => t);
    expect(await g.reserveInference(t + 5_000)).toEqual({ decision: "store_error" });
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, okOut()) };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: t + 5_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: () => t });
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reserved: 0, reservationsUnknown: 1 });
    expect(calls).toBe(0);
  });

  it("repro: the same bad answer from the RATE check → AI_DISABLED, no model call", async () => {
    const g = new UsageGuard(bad({ allowed: "false", count: 0 }), LIMITS(10));
    expect(await g.checkRate("c")).toBe("store_error");
    let calls = 0;
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), ON, {
      model: { generate: async () => (calls++, okOut()) },
      config: CFG,
      usage: g,
      logger: () => {},
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
  });

  it.each([
    ["allowed as a string \"true\"", { allowed: "true", count: 1 }],
    ["allowed as 1", { allowed: 1, count: 1 }],
    ["allowed missing", { count: 1 }],
    ["count as a string", { allowed: true, count: "1" }],
    ["count negative", { allowed: true, count: -1 }],
    ["count fractional", { allowed: true, count: 1.5 }],
    ["count NaN", { allowed: true, count: Number.NaN }],
    ["count above the limit", { allowed: true, count: 61 }],
    ["allowed with count 0 (nothing was added)", { allowed: true, count: 0 }],
    ["denied with count above the limit", { allowed: false, count: 61 }],
    ["an extra field", { allowed: true, count: 1, expiresAtMs: 1 }],
    ["an array", [true, 1]],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["a boolean", true],
  ])("%s → store_error (daily reservation and rate check)", async (_n, value) => {
    const g = new UsageGuard(bad(value), LIMITS(10));
    expect(await g.reserveInference()).toEqual({ decision: "store_error" });
    expect(await g.checkRate("c")).toBe("store_error");
  });

  it("a getter on a result field is never invoked and is rejected", async () => {
    let n = 0;
    const value = Object.defineProperty({ count: 1 }, "allowed", { enumerable: true, get: () => (n++, true) });
    const g = new UsageGuard(bad(value), LIMITS(10));
    expect(await g.reserveInference()).toEqual({ decision: "store_error" });
    expect(n).toBe(0);
  });

  it("valid results keep working (allowed and limited)", async () => {
    const g = new UsageGuard(bad({ allowed: true, count: 3 }), LIMITS(10));
    expect((await g.reserveInference()).decision).toBe("allowed");
    const l = new UsageGuard(bad({ allowed: false, count: 10 }), LIMITS(10));
    expect(await l.reserveInference()).toEqual({ decision: "limited" });
    expect(await l.checkRate("c")).toBe("limited");
  });

  it("an invalid answer on the RETRY reservation → the first error is kept, no second call", async () => {
    let n = 0;
    const base = new InMemoryUsageStore();
    const store: UsageStore = { kind: "flaky", consume: async (...a) => (a[0].startsWith("daily:") && ++n === 2 ? ({ allowed: "true", count: 2 } as never) : base.consume(...a)) };
    const g = new UsageGuard(store, LIMITS(10));
    let calls = 0;
    const model: MenuModel = {
      generate: async () => {
        calls++;
        throw transient();
      },
    };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: (d) => g.reserveInference(d) }, { sleep: async () => {} });
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1, reserved: 1, reservationsUnknown: 1, limitReason: "retry_usage_store_error" });
    expect(calls).toBe(1);
  });

  it("the shared validation boundary is exported for every store (in-memory output passes it)", async () => {
    const s = new InMemoryUsageStore();
    const r = await s.consume("k", 1, 2, Date.now() + 1_000);
    expect(() => assertConsumeResult(r, 1, 2)).not.toThrow();
    expect(() => assertConsumeResult({ allowed: "false", count: 0 }, 1, 2)).toThrow();
  });

  it("production without a shared store stays AI_DISABLED with 0 model calls", async () => {
    let calls = 0;
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), { ...ON, DAILY_INFERENCE_LIMIT: "10" }, {
      model: { generate: async () => (calls++, okOut()) },
      config: CFG,
      logger: () => {},
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
  });
});
