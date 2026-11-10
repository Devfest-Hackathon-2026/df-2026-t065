import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, validateReservation, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import type { MenuModel, ModelCallResult } from "@/server/gemini/vertexClient";
import { UsageGuard } from "@/server/usage/guard";
import { InMemoryUsageStore, type UsageStore } from "@/server/usage/store";
import { blob, fakeJpeg, testUsageGuard } from "./helpers";

/*
 * PR #5 second independent audit (REVISE): MAJOR-A (clock rewinds while a
 * reservation is pending), MAJOR-B (exceptions leaking through Promise
 * assimilation of hostile values), MINOR (mutations previously called
 * "equivalent"). Model, store and clock are test doubles. All model outputs are
 * SYNTHETIC.
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
const NOV6 = "2026-11-06";
const NOV7 = "2026-11-07";
/** A confirmed permit for the JST day [fromMs, untilMs). */
const permit = (fromMs: number, untilMs: number) => ({ decision: "allowed" as const, validFromMs: fromMs, validUntilMs: untilMs });
const DAY_D = permit(MIDNIGHT - DAY, MIDNIGHT); // 11/6
const DAY_D1 = permit(MIDNIGHT, MIDNIGHT + DAY); // 11/7

function counting(behaviour: (n: number) => Promise<ModelCallResult> = async () => okOut()) {
  let calls = 0;
  const startedAt: number[] = [];
  return {
    model: (clock: () => number): MenuModel => ({ generate: async () => (startedAt.push(clock()), behaviour(++calls)) }),
    calls: () => calls,
    startedAt,
  };
}

// ---------------------------------------------------------------------------
describe("MAJOR-A: a clock that goes back while a reservation is pending", () => {
  it("audit repro: 11/6 full, reservation starts 11/7 00:00:00.001, clock rewinds to 11/6 23:59:59.999 → no start on 11/6", async () => {
    let t = MIDNIGHT - 10;
    const now = () => t;
    const base = new InMemoryUsageStore(now);
    await base.consume(`daily:${NOV6}`, 2, 2, MIDNIGHT); // 1. the 11/6 daily limit is full
    t = MIDNIGHT + 1; // 2. the reservation starts at 11/7 00:00:00.001
    const store: UsageStore = {
      kind: "rewind",
      consume: async (key, amount, limit, exp) => {
        const r = await base.consume(key, amount, limit, exp); // charged to 11/7
        if (key.startsWith("daily:")) t = MIDNIGHT - 1; // 3./4. the clock goes back to 11/6 23:59:59.999 while we wait, then stays there
        return r;
      },
    };
    const g = new UsageGuard(store, LIMITS(2), now);
    const m = counting();
    const out = await analyzeWithGemini(m.model(now), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now });
    expect(m.startedAt).toEqual([]); // the 11/7 unit is never used for a start on 11/6
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, reserved: 1 });
  });

  it("the same rewind on the RETRY → the retry never starts", async () => {
    let t = MIDNIGHT + 1;
    const now = () => t;
    let dailyCalls = 0;
    const base = new InMemoryUsageStore(now);
    const store: UsageStore = {
      kind: "rewind",
      consume: async (key, amount, limit, exp) => {
        const r = await base.consume(key, amount, limit, exp);
        if (key.startsWith("daily:") && ++dailyCalls === 2) t = MIDNIGHT - 1;
        return r;
      },
    };
    const g = new UsageGuard(store, LIMITS(10), now);
    const m = counting(async (n) => {
      if (n === 1) throw transient();
      return okOut();
    });
    const out = await analyzeWithGemini(m.model(now), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now, sleep: async () => {} });
    expect(m.startedAt).toEqual([MIDNIGHT + 1]);
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", failure: "upstream_transient", attempts: 1, limitReason: "retry_clock_invalid", reserved: 2 });
  });

  it("a permit for 11/7 is never used for a start on 11/6 (not yet valid), even without a detected rewind", async () => {
    const t = MIDNIGHT - 1;
    const m = counting();
    const out = await analyzeWithGemini(m.model(() => t), CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: async () => DAY_D1 }, { now: () => t });
    expect(m.calls()).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "reservation_not_yet_valid", attempts: 0, reserved: 1 });
  });

  it("a not-yet-valid permit on the RETRY → the retry never starts", async () => {
    const t = MIDNIGHT - 1;
    let n = 0;
    const m = counting(async (k) => {
      if (k === 1) throw transient();
      return okOut();
    });
    const out = await analyzeWithGemini(m.model(() => t), CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: async () => (++n === 1 ? DAY_D : DAY_D1) }, { now: () => t, sleep: async () => {} });
    expect(m.calls()).toBe(1);
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1, limitReason: "retry_reservation_not_yet_valid" });
  });

  it("a permit for 11/6 is never used for a start on 11/7 (expired → one new reservation)", async () => {
    const t = MIDNIGHT;
    let n = 0;
    const m = counting();
    const out = await analyzeWithGemini(m.model(() => t), CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: async () => (++n === 1 ? DAY_D : DAY_D1) }, { now: () => t });
    expect(m.startedAt).toEqual([MIDNIGHT]);
    expect(out).toMatchObject({ ok: true, attempts: 1, reserved: 2, reservationsRolledOver: 1 });
  });

  it("exactly 00:00:00.000: the 11/7 permit is valid (start inclusive), the 11/6 permit is not (end exclusive)", async () => {
    const t = MIDNIGHT;
    const ok = counting();
    expect((await analyzeWithGemini(ok.model(() => t), CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: async () => DAY_D1 }, { now: () => t })).ok).toBe(true);
    expect(ok.calls()).toBe(1);
    const old = counting();
    const out = await analyzeWithGemini(old.model(() => t), CFG, REQ, { requestId: "r", deadlineAt: t + 8_000, reserveAttempt: async () => DAY_D }, { now: () => t });
    expect(old.calls()).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "reservation_expired", reserved: 2, reservationsRolledOver: 2 });
  });

  it("the guard's permit spans exactly the JST day of the reservation [00:00, next 00:00)", async () => {
    let t = MIDNIGHT - 1;
    const g = new UsageGuard(new InMemoryUsageStore(() => t), LIMITS(10), () => t);
    expect(await g.reserveInference(t + 5_000)).toEqual({ decision: "allowed", ...{ validFromMs: MIDNIGHT - DAY, validUntilMs: MIDNIGHT } });
    t = MIDNIGHT;
    expect(await g.reserveInference(t + 5_000)).toEqual({ decision: "allowed", validFromMs: MIDNIGHT, validUntilMs: MIDNIGHT + DAY });
  });

  it("normal reservations keep working end to end (guard + runner)", async () => {
    const t = MIDNIGHT + 3_600_000;
    const g = new UsageGuard(new InMemoryUsageStore(() => t), LIMITS(10), () => t);
    const m = counting();
    expect(await analyzeWithGemini(m.model(() => t), CFG, REQ, { requestId: "r", reserveAttempt: (d) => g.reserveInference(d) }, { now: () => t })).toMatchObject({ ok: true, reserved: 1, reservationsRolledOver: 0 });
  });

  it.each([
    ["validFrom after validUntil", permit(MIDNIGHT + DAY, MIDNIGHT)],
    ["validFrom equal to validUntil", permit(MIDNIGHT, MIDNIGHT)],
    ["validFrom NaN", permit(Number.NaN, MIDNIGHT)],
    ["validFrom negative", permit(-1, MIDNIGHT)],
    ["validFrom fractional", permit(MIDNIGHT - 0.5, MIDNIGHT)],
    ["validFrom missing", { decision: "allowed", validUntilMs: MIDNIGHT }],
    ["validUntil missing", { decision: "allowed", validFromMs: MIDNIGHT }],
    ["an extra field", { ...DAY_D1, dayKey: NOV7 }],
  ])("an inconsistent permit (%s) → store_error, 0 starts, counted as unknown", async (_n, value) => {
    const m = counting();
    const out = await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (async () => value) as unknown as ReserveAttempt }, { now: () => MIDNIGHT });
    expect(m.calls()).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reservationsUnknown: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("MAJOR-B: hostile values never leak an exception through Promise assimilation", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  /** A Proxy that schedules its own revocation the moment `then` is read (audit repro). */
  function revokeOnThen<T extends object>(target: T): T {
    const { proxy, revoke } = Proxy.revocable(target, {
      get(t, k, r) {
        if (k === "then") queueMicrotask(revoke);
        return Reflect.get(t, k, r);
      },
    });
    return proxy;
  }
  function revoked<T extends object>(target: T): T {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
  }
  const throwingKeys = <T extends object>(target: T): T => new Proxy(target, { ownKeys: () => { throw new Error("SYNTHETIC_SECRET_TOKEN"); } });

  it.each([
    ["audit repro: a permit Proxy that revokes itself when `then` is read", () => revokeOnThen(DAY_D1)],
    ["an already revoked permit Proxy (Proxy.revocable)", () => revoked(DAY_D1)],
    ["a permit Proxy whose ownKeys throws", () => throwingKeys(DAY_D1)],
  ])("%s → the runner resolves with store_error, 0 starts, no unhandledRejection", async (_n, make) => {
    const m = counting();
    const out = await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (async () => make()) as unknown as ReserveAttempt }, { now: () => MIDNIGHT });
    await settle();
    expect(m.calls()).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reserved: 0, reservationsUnknown: 1 });
    expect(unhandled).toEqual([]);
  });

  it.each([
    ["a hook that returns the self-revoking Proxy synchronously (no Promise)", () => revokeOnThen(DAY_D1)],
    ["a hook that returns a revoked Proxy synchronously", () => revoked(DAY_D1)],
  ])("%s → store_error, no unhandledRejection", async (_n, make) => {
    const m = counting();
    const out = await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (() => make()) as unknown as ReserveAttempt }, { now: () => MIDNIGHT });
    await settle();
    expect(m.calls()).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reservationsUnknown: 1 });
    expect(unhandled).toEqual([]);
  });

  it.each([
    ["a consume result Proxy that revokes itself when `then` is read", () => revokeOnThen({ allowed: true, count: 1 })],
    ["an already revoked consume result Proxy", () => revoked({ allowed: true, count: 1 })],
    ["a consume result Proxy whose ownKeys throws", () => throwingKeys({ allowed: true, count: 1 })],
  ])("%s → the guard answers store_error (daily and rate), the runner 0 starts, no unhandledRejection", async (_n, make) => {
    const store: UsageStore = { kind: "hostile", consume: async () => make() as never };
    const g = new UsageGuard(store, LIMITS(10), () => MIDNIGHT);
    expect(await g.reserveInference(MIDNIGHT + 5_000)).toEqual({ decision: "store_error" });
    expect(await g.checkRate("c", MIDNIGHT + 5_000)).toBe("store_error");
    const syncStore: UsageStore = { kind: "hostile-sync", consume: (() => make()) as never };
    expect(await new UsageGuard(syncStore, LIMITS(10), () => MIDNIGHT).reserveInference(MIDNIGHT + 5_000)).toEqual({ decision: "store_error" });
    const m = counting();
    const out = await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: () => MIDNIGHT });
    await settle();
    expect(m.calls()).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reservationsUnknown: 1 });
    expect(unhandled).toEqual([]);
  });

  it("the handler with a self-revoking store result → AI_DISABLED (structured), no unhandledRejection", async () => {
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    let calls = 0;
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), ON, {
      model: { generate: async () => (calls++, okOut()) },
      config: CFG,
      usage: new UsageGuard({ kind: "hostile", consume: async () => revokeOnThen({ allowed: true, count: 1 }) as never }, LIMITS(10)),
      logger: () => {},
    });
    await settle();
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it.each(["hook", "store"] as const)("a SYNCHRONOUS thenable from the %s is never assimilated: its `then` is never read nor called", async (where) => {
    let thenReads = 0;
    let thenCalls = 0;
    const value = where === "hook" ? { ...DAY_D1 } : { allowed: true, count: 1 };
    Object.defineProperty(value, "then", {
      enumerable: false,
      get() {
        thenReads++;
        return (resolve: (v: unknown) => void) => {
          thenCalls++;
          resolve(where === "hook" ? DAY_D1 : { allowed: true, count: 1 }); // would look valid if assimilated
        };
      },
    });
    const m = counting();
    if (where === "hook") {
      const out = await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (() => value) as unknown as ReserveAttempt }, { now: () => MIDNIGHT });
      expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reservationsUnknown: 1 });
    } else {
      const g = new UsageGuard({ kind: "thenable", consume: (() => value) as never }, LIMITS(10), () => MIDNIGHT);
      expect(await g.reserveInference(MIDNIGHT + 5_000)).toEqual({ decision: "store_error" });
    }
    await settle();
    expect(m.calls()).toBe(0);
    expect(thenReads).toBe(0);
    expect(thenCalls).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("normal Promises and plain objects keep working (permit and consume result)", async () => {
    const m = counting();
    expect((await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: async () => DAY_D1 }, { now: () => MIDNIGHT })).ok).toBe(true);
    expect((await analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: () => Promise.resolve(DAY_D1) }, { now: () => MIDNIGHT })).ok).toBe(true);
    const g = new UsageGuard({ kind: "ok", consume: async () => ({ allowed: true, count: 1 }) }, LIMITS(10), () => MIDNIGHT);
    expect((await g.reserveInference(MIDNIGHT + 5_000)).decision).toBe("allowed");
    expect(await g.checkRate("c", MIDNIGHT + 5_000)).toBe("allowed");
    expect(unhandled).toEqual([]);
  });

  it("in a SEPARATE Node process: no unhandledRejection, no uncaughtException, all scenarios fail closed", () => {
    const out = execFileSync(process.execPath, [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "--config", "tests/server/childProcess/vitest.child.config.ts", "--reporter=dot", "hostile.child"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    expect(out).toMatch(/1 passed/);
    expect(out).not.toMatch(/Unhandled/i);
  }, 90_000);
});

// ---------------------------------------------------------------------------
describe("MINOR: the two mutations previously called 'equivalent' are distinguishable", () => {
  it("permit validation catch: a revoked Proxy makes Array.isArray throw → must become store_error, not a rejection", async () => {
    const { proxy, revoke } = Proxy.revocable(DAY_D1, {});
    revoke();
    expect(() => Array.isArray(proxy)).toThrow(TypeError);
    const m = counting();
    await expect(analyzeWithGemini(m.model(() => MIDNIGHT), CFG, REQ, { requestId: "r", deadlineAt: MIDNIGHT + 8_000, reserveAttempt: (async () => proxy) as unknown as ReserveAttempt }, { now: () => MIDNIGHT })).resolves.toMatchObject({ failure: "usage_store_error" });
    expect(m.calls()).toBe(0);
  });

  it("validateReservation itself never throws: a revoked Proxy (Array.isArray throws first) → store_error", () => {
    const { proxy, revoke } = Proxy.revocable(DAY_D1, {});
    revoke();
    expect(() => validateReservation(proxy)).not.toThrow();
    expect(validateReservation(proxy)).toEqual({ decision: "store_error" });
    expect(validateReservation(new Proxy(DAY_D1, { ownKeys: () => { throw new Error("x"); } }))).toEqual({ decision: "store_error" });
    expect(validateReservation(DAY_D1)).toEqual(DAY_D1);
    expect(validateReservation(DAY_D1)).not.toBe(DAY_D1); // a fresh object of our own
  });

  it.each(["reserveInference", "checkRate"] as const)("%s: a clock that THROWS on its first read → store_error (no rejection), the store is NOT called", async (method) => {
    let reads = 0;
    const now = () => {
      if (reads++ === 0) throw new Error("SYNTHETIC_SECRET_TOKEN");
      return 1_000;
    };
    let storeCalls = 0;
    const g = new UsageGuard({ kind: "count", consume: async () => (storeCalls++, { allowed: true, count: 1 }) }, LIMITS(10), now);
    const r = method === "reserveInference" ? await g.reserveInference(9_000) : await g.checkRate("c", 9_000);
    expect(r === "store_error" || (typeof r === "object" && r.decision === "store_error")).toBe(true);
    expect(storeCalls).toBe(0);
  });

  it("reserveInference's own clock check: first read 1.5, later reads 1000 → store_error and the store is NOT called", async () => {
    let reads = 0;
    const now = () => (reads++ === 0 ? 1.5 : 1_000);
    let storeCalls = 0;
    const g = new UsageGuard({ kind: "count", consume: async () => (storeCalls++, { allowed: true, count: 1 }) }, LIMITS(10), now);
    expect(await g.reserveInference(9_000)).toEqual({ decision: "store_error" });
    expect(storeCalls).toBe(0);
  });

  it("checkRate's own clock check: first read 1.5, later reads 1000 → store_error and the store is NOT called", async () => {
    let reads = 0;
    const now = () => (reads++ === 0 ? 1.5 : 1_000);
    let storeCalls = 0;
    const g = new UsageGuard({ kind: "count", consume: async () => (storeCalls++, { allowed: true, count: 1 }) }, LIMITS(10), now);
    expect(await g.checkRate("c", 9_000)).toBe("store_error");
    expect(storeCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("regressions kept", () => {
  it("production without a shared store stays AI_DISABLED with 0 model calls", async () => {
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    let calls = 0;
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), { ...ON, DAILY_INFERENCE_LIMIT: "10" }, {
      model: { generate: async () => (calls++, okOut()) },
      config: CFG,
      logger: () => {},
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
    void testUsageGuard;
  });
});
