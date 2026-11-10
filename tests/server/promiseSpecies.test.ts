import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import type { MenuModel, ModelCallResult } from "@/server/gemini/vertexClient";
import { UsageGuard } from "@/server/usage/guard";
import { settleUntrusted } from "@/server/untrusted";
import type { UsageStore } from "@/server/usage/store";
import { scenarios } from "./childProcess/speciesScenarios";
import { fakeJpeg } from "./helpers";

/*
 * PR #5 final MAJOR: Promise subclasses / Symbol.species. Untrusted Promise
 * subclasses must never be subscribed to; only plain synchronous values or
 * verifiable native Promises are accepted. Both paths: the reservation hook
 * (runner) and UsageStore.consume (guard). SYNTHETIC values only.
 */

const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const T = Date.UTC(2026, 10, 6, 15, 0, 0) + 3_600_000; // 11/7 01:00 JST
const PERMIT = { decision: "allowed" as const, validFromMs: Date.UTC(2026, 10, 6, 15, 0, 0), validUntilMs: Date.UTC(2026, 10, 7, 15, 0, 0) };
const RESULT = { allowed: true, count: 1 };
const LIMITS = { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 };
const okOut = (): ModelCallResult => ({ text: "{}", finishReason: "STOP" });

let unhandled: unknown[] = [];
const onAsyncError = (e: unknown) => void unhandled.push(e);
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onAsyncError);
  process.on("uncaughtException", onAsyncError);
});
afterEach(() => {
  process.off("unhandledRejection", onAsyncError);
  process.off("uncaughtException", onAsyncError);
});
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("reservation hook path (runner)", () => {
  it.each(scenarios().map((s) => [s.name, s] as const))("%s", async (_n, s) => {
    let starts = 0;
    const model: MenuModel = { generate: async () => (starts++, okOut()) };
    const hook = (() => s.make(PERMIT)) as unknown as ReserveAttempt;
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: T + 8_000, reserveAttempt: hook }, { now: () => T });
    await settle();
    if (s.refuse) {
      expect(starts).toBe(0);
      expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reserved: 0, reservationsUnknown: 1 });
    } else {
      expect(starts).toBe(1);
      expect(out).toMatchObject({ reserved: 1, reservationsUnknown: 0 });
    }
    expect(s.getterCalls?.() ?? 0).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe("UsageStore.consume path (guard, then runner)", () => {
  it.each(scenarios().map((s) => [s.name, s] as const))("%s", async (_n, s) => {
    const store: UsageStore = { kind: "untrusted", consume: (() => s.make(RESULT)) as never };
    const g = new UsageGuard(store, LIMITS, () => T);
    const rate = await g.checkRate("c", T + 8_000);
    let starts = 0;
    const model: MenuModel = { generate: async () => (starts++, okOut()) };
    const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: T + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: () => T });
    await settle();
    if (s.refuse) {
      expect(rate).toBe("store_error");
      expect(starts).toBe(0);
      expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reserved: 0, reservationsUnknown: 1 });
    } else {
      expect(rate).toBe("allowed");
      expect(starts).toBe(1);
    }
    expect(s.getterCalls?.() ?? 0).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe("the Promise intrinsics are verified, not assumed", () => {
  it.each([
    ["Promise[Symbol.species]", () => Object.getOwnPropertyDescriptor(Promise, Symbol.species)!, (d: PropertyDescriptor) => Object.defineProperty(Promise, Symbol.species, d)],
    ["Promise.prototype.constructor", () => Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")!, (d: PropertyDescriptor) => Object.defineProperty(Promise.prototype, "constructor", d)],
  ])("a replaced %s → even a plain native Promise is refused without subscribing", async (_n, read, write) => {
    const original = read();
    const value = Promise.resolve(RESULT);
    let settled: Promise<unknown>;
    let speciesCalls = 0;
    try {
      write({ configurable: true, get: () => (speciesCalls++, Promise) } as PropertyDescriptor);
      settled = settleUntrusted(value, (v) => v, "FALLBACK"); // the decision is made synchronously…
    } finally {
      write(original); // …and the intrinsic is restored before anything else runs
    }
    expect(await settled).toBe("FALLBACK");
    expect(speciesCalls).toBe(0);
    expect(await settleUntrusted(Promise.resolve(RESULT), (v) => v, "FALLBACK")).toEqual(RESULT); // restored: accepted again
  });
});

describe("separate Node process", () => {
  it("all scenarios on both paths: no model start for refused values, 0 unhandledRejection, 0 uncaughtException", () => {
    const out = execFileSync(
      process.execPath,
      [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "--config", "tests/server/childProcess/vitest.child.config.ts", "--reporter=dot", "species.child"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    const plain = out.replace(/\u001b\[[0-9;]*m/g, ""); // no colour codes, whatever the environment
    expect(plain).toMatch(/Tests\s+1 passed/);
    expect(plain).not.toMatch(/Unhandled|uncaught/i);
  }, 90_000);
});
