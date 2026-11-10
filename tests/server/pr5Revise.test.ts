import { ApiError } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini } from "@/server/gemini/analyzeWithGemini";
import { createVertexMenuModel, type MenuModel, type ModelCallResult } from "@/server/gemini/vertexClient";
import { sanitizeLogEvent, type LogEvent } from "@/server/log";
import { UsageGuard, clientKey, normalizeClientIp, readUsageConfig } from "@/server/usage/guard";
import { InMemoryUsageStore, type UsageStore } from "@/server/usage/store";
import { blob, fakeJpeg } from "./helpers";

/*
 * Regression tests for the PR5 independent audit (REVISE): M1, M2, m1–m3.
 * Model, store, ADC and network are test doubles. All model outputs are SYNTHETIC.
 */

const ON: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const GOOD = {
  status: "ok",
  imageIssues: [],
  items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
  menuNotices: [],
};
const okOut = (): ModelCallResult => ({ text: JSON.stringify(GOOD), finishReason: "STOP" });
const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 5000, maxOutputTokens: 4096 };

function counting(behaviour: (n: number) => Promise<ModelCallResult> = async () => okOut()) {
  let calls = 0;
  const model: MenuModel = { generate: async () => behaviour(++calls) };
  return { model, calls: () => calls };
}
function request(xff?: string): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f, headers: xff ? { "x-forwarded-for": xff } : {} });
}
async function code(res: Response) {
  return AnalyzeMenuErrorSchema.parse(await res.json()).error.code;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe("M1: X-Forwarded-For trust boundary and IP normalisation", () => {
  it("reproduces the audit bypass: with TRUSTED_PROXY_HOPS=2 behind ONE proxy, spoofed entries create fresh buckets", async () => {
    // The real path appends one entry; the client controls everything to its left.
    const g = new UsageGuard(new InMemoryUsageStore(), { dailyInferenceLimit: 100, ratePerMinute: 1, trustedProxyHops: 2 });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await g.checkRate(clientKey(request(`10.9.9.${i}, 203.0.113.7`), 2)));
    // This is exactly why non-zero hops must not be usable in production until the ingress is verified.
    expect(results).toEqual(["allowed", "allowed", "allowed", "allowed"]);
  });

  it.each(["1", "2", "3"])("production refuses TRUSTED_PROXY_HOPS=%s until the ingress path is approved (fail closed)", (hops) => {
    const shared = () => new InMemoryUsageStore(); // stands in for an approved shared store
    const r = readUsageConfig(
      { NODE_ENV: "production", GEMINI_ENABLED: "true", USAGE_STORE: "shared-test", DAILY_INFERENCE_LIMIT: "10", TRUSTED_PROXY_HOPS: hops },
      { "shared-test": shared },
    );
    expect(r).toEqual({ ok: false, failure: "usage_config_invalid" });
  });

  it("production with hops 0 (default) is accepted with an approved shared store", () => {
    const r = readUsageConfig(
      { NODE_ENV: "production", GEMINI_ENABLED: "true", USAGE_STORE: "shared-test", DAILY_INFERENCE_LIMIT: "10" },
      { "shared-test": () => new InMemoryUsageStore() },
    );
    expect(r.ok).toBe(true);
  });

  it("the handler fails closed for a non-zero hops setting in production (no model call)", async () => {
    const { model, calls } = counting();
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(
      request("203.0.113.7"),
      { ...ON, USAGE_STORE: "shared-test", DAILY_INFERENCE_LIMIT: "10", TRUSTED_PROXY_HOPS: "2" },
      { model, config: CFG, usageStores: { "shared-test": () => new InMemoryUsageStore() }, logger: (e) => logs.push(e) },
    );
    expect(await code(res)).toBe("AI_DISABLED");
    expect(calls()).toBe(0);
    expect(logs[0]).toMatchObject({ failure: "usage_config_invalid" });
  });

  it("a header shorter than the trusted hops falls back to the shared bucket (never a fresh one)", () => {
    expect(clientKey(request("203.0.113.7"), 2)).toBe("unidentified");
    expect(clientKey(request(""), 1)).toBe("unidentified");
  });

  it.each([
    ["compressed vs full", "2001:db8:1:2::1", "2001:0db8:0001:0002:0000:0000:0000:0001"],
    ["case", "2001:DB8:1:2::abcd", "2001:db8:1:2:0:0:0:abcd"],
    ["same /64, different host", "2001:db8:1:2:aaaa::1", "2001:db8:1:2:bbbb::2"],
    ["IPv4-mapped (dotted) equals IPv4", "::ffff:203.0.113.7", "203.0.113.7"],
    ["IPv4-mapped (hex) equals IPv4", "::ffff:cb00:7107", "203.0.113.7"],
    ["IPv4-mapped, full form", "0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
  ])("normalises equivalent addresses to one bucket: %s", (_n, a, b) => {
    expect(normalizeClientIp(a)).not.toBeNull();
    expect(normalizeClientIp(a)).toBe(normalizeClientIp(b));
  });

  it.each([
    ["different IPv4 hosts", "203.0.113.7", "203.0.113.8"],
    ["different /64", "2001:db8:1:2::1", "2001:db8:1:3::1"],
    ["IPv4 vs a non-mapped IPv6", "203.0.113.7", "::cb00:7107"],
  ])("keeps different clients apart: %s", (_n, a, b) => {
    expect(normalizeClientIp(a)).not.toBe(normalizeClientIp(b));
  });

  it.each([
    "203.0.113.256",
    "01.2.3.4",
    "1.2.3",
    "1.2.3.4:8080",
    "[2001:db8::1]:443",
    "fe80::1%eth0",
    "2001:db8::1::2",
    "2001:db8:1:2:3:4:5:6:7",
    "::ffff:1.2.3.999",
    "not-an-ip",
    "",
    " 203.0.113.7x",
  ])("invalid value %j → unidentified", (v) => {
    expect(normalizeClientIp(v)).toBeNull();
    expect(clientKey(request(v || undefined), 1)).toBe("unidentified");
  });

  it("buckets: NAT users share one bucket; unidentified clients share one bucket", async () => {
    const g = new UsageGuard(new InMemoryUsageStore(), { dailyInferenceLimit: 100, ratePerMinute: 1, trustedProxyHops: 1 });
    expect(await g.checkRate(clientKey(request("198.51.100.1"), 1))).toBe("allowed");
    expect(await g.checkRate(clientKey(request("198.51.100.1"), 1))).toBe("limited"); // two people behind one NAT address
    expect(await g.checkRate(clientKey(request("garbage"), 1))).toBe("allowed");
    expect(await g.checkRate(clientKey(request(undefined), 1))).toBe("limited"); // unidentified share one bucket
  });

  it("fixed window boundary: 59.999 s is the same window, 60.000 s is a new one", async () => {
    let t = 1_800_000_000_000 - (1_800_000_000_000 % 60_000); // start of a window
    const g = new UsageGuard(new InMemoryUsageStore(() => t), { dailyInferenceLimit: 100, ratePerMinute: 1, trustedProxyHops: 0 }, () => t);
    expect(await g.checkRate("c")).toBe("allowed");
    t += 59_999;
    expect(await g.checkRate("c")).toBe("limited");
    t += 1;
    expect(await g.checkRate("c")).toBe("allowed");
  });
});

// ---------------------------------------------------------------------------
describe("M2: one absolute deadline covers store waits, rate check, reservations, backoff and model calls", () => {
  /** A fake clock: store operations can "take" a given amount of time instantly. */
  function clockedStore(delays: { rate?: number; daily?: (n: number) => number }) {
    let t = Date.parse("2026-11-06T03:00:00Z");
    const base = new InMemoryUsageStore(() => t); // the store, the guard and the handler share ONE clock
    let dailyN = 0;
    const store: UsageStore = {
      kind: "clocked",
      consume: async (key, amount, limit, exp) => {
        if (key.startsWith("rate:")) t += delays.rate ?? 0;
        else t += delays.daily?.(++dailyN) ?? 0;
        return base.consume(key, amount, limit, exp);
      },
    };
    return { store, now: () => t, base };
  }

  it("a reservation that succeeds at 5,001 ms of a 5,000 ms deadline → 0 model calls", async () => {
    const c = clockedStore({ daily: () => 5_001 });
    const { model, calls } = counting();
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, {
      model,
      config: { ...CFG, requestDeadlineMs: 5_000 },
      usage: new UsageGuard(c.store, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, c.now),
      now: c.now,
      logger: (e) => logs.push(e),
    });
    expect(calls()).toBe(0);
    expect(await code(res)).toBe("AI_DISABLED");
    expect(logs[0]).toMatchObject({ failure: "usage_reservation_late", reserved: 1 });
  });

  it("a RETRY reservation that finishes after the deadline → no retry", async () => {
    const c = clockedStore({ daily: (n) => (n === 2 ? 5_001 : 0) });
    const { model, calls } = counting(async (n) => {
      if (n === 1) throw new ApiError({ message: "x", status: 503 });
      return okOut();
    });
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, {
      model,
      config: { ...CFG, requestDeadlineMs: 5_000 },
      usage: new UsageGuard(c.store, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, c.now),
      now: c.now,
      sleep: async () => {},
      logger: (e) => logs.push(e),
    });
    expect(calls()).toBe(1);
    expect(await code(res)).toBe("AI_FAILED"); // the first attempt's error
    expect(logs[0]).toMatchObject({ limitReason: "retry_usage_reservation_late", reserved: 2 });
  });

  it("the rate check consumes the same deadline", async () => {
    const c = clockedStore({ rate: 5_001 });
    const { model, calls } = counting();
    const logs: LogEvent[] = [];
    await handleAnalyzeMenu(request(), ON, {
      model,
      config: { ...CFG, requestDeadlineMs: 5_000 },
      usage: new UsageGuard(c.store, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, c.now),
      now: c.now,
      logger: (e) => logs.push(e),
    });
    expect(calls()).toBe(0);
    expect(logs[0]).toMatchObject({ failure: "rate_check_late" });
  });

  it("a model call is never started with (almost) no time left", async () => {
    const c = clockedStore({ daily: () => 4_500 }); // 500 ms left after the reservation
    const { model, calls } = counting();
    await handleAnalyzeMenu(request(), ON, {
      model,
      config: { ...CFG, requestDeadlineMs: 5_000 },
      usage: new UsageGuard(c.store, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, c.now),
      now: c.now,
      logger: () => {},
    });
    expect(calls()).toBe(0);
  });

  it("a reservation that never resolves still ends the request within the deadline (real timers)", async () => {
    const hanging: UsageStore = { kind: "hang", consume: (key) => (key.startsWith("daily:") ? new Promise(() => {}) : Promise.resolve({ allowed: true, count: 1 })) };
    const { model, calls } = counting();
    const logs: LogEvent[] = [];
    const t0 = Date.now();
    const res = await handleAnalyzeMenu(request(), ON, {
      model,
      config: { ...CFG, requestDeadlineMs: 1_300, attemptTimeoutMs: 1_000 }, // enough to start the reservation
      usage: new UsageGuard(hanging, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }),
      logger: (e) => logs.push(e),
    });
    expect(Date.now() - t0).toBeLessThan(1_900);
    expect(await code(res)).toBe("AI_DISABLED");
    expect(logs[0]).toMatchObject({ failure: "usage_store_timeout" });
    expect(calls()).toBe(0);
  });

  it("an outcome that arrives after the deadline is still counted (never under-counted)", async () => {
    const base = new InMemoryUsageStore();
    const late: UsageStore = {
      kind: "late",
      consume: async (key, amount, limit, exp) => {
        if (key.startsWith("daily:")) await new Promise((r) => setTimeout(r, 1_500));
        return base.consume(key, amount, limit, exp);
      },
    };
    const g = new UsageGuard(late, { dailyInferenceLimit: 1, ratePerMinute: 60, trustedProxyHops: 0 });
    const { model, calls } = counting();
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, { model, config: { ...CFG, requestDeadlineMs: 1_200, attemptTimeoutMs: 1_000 }, usage: g, logger: (e) => logs.push(e) });
    expect(await code(res)).toBe("AI_DISABLED");
    expect(logs[0]).toMatchObject({ failure: "usage_store_timeout" });
    expect(calls()).toBe(0);
    await new Promise((r) => setTimeout(r, 600));
    // The late reservation went through: the only unit of the day is gone.
    const direct = new UsageGuard(base, { dailyInferenceLimit: 1, ratePerMinute: 60, trustedProxyHops: 0 });
    expect((await direct.reserveInference()).decision).toBe("limited");
  });

  it("a store factory that throws synchronously becomes AI_DISABLED, not an unhandled exception", async () => {
    const { model, calls } = counting();
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(
      request(),
      { ...ON, USAGE_STORE: "boom", DAILY_INFERENCE_LIMIT: "10" },
      {
        model,
        config: CFG,
        usageStores: {
          boom: () => {
            throw new Error("init failed: SYNTHETIC_SECRET_TOKEN");
          },
        },
        logger: (e) => logs.push(e),
      },
    );
    expect(await code(res)).toBe("AI_DISABLED");
    expect(calls()).toBe(0);
    expect(logs[0]).toMatchObject({ failure: "usage_store_error" });
    expect(JSON.stringify(logs)).not.toContain("SYNTHETIC_SECRET_TOKEN");
  });

  it("normal requests and retries inside the deadline still work", async () => {
    const { model, calls } = counting(async (n) => {
      if (n === 1) throw new ApiError({ message: "x", status: 503 });
      return okOut();
    });
    const g = new UsageGuard(new InMemoryUsageStore(), { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 });
    const res = await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, sleep: async () => {}, logger: () => {} });
    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("m1: UsageStore input contract", () => {
  const future = () => Date.now() + 60_000;
  it.each([
    ["amount 0", 0, 5],
    ["amount negative", -1, 5],
    ["amount fractional", 1.5, 5],
    ["amount NaN", Number.NaN, 5],
    ["amount unsafe", Number.MAX_SAFE_INTEGER + 1, 5],
    ["limit 0", 1, 0],
    ["limit fractional", 1, 2.5],
    ["limit Infinity", 1, Number.POSITIVE_INFINITY],
  ])("rejects %s without touching the counter", async (_n, amount, limit) => {
    const s = new InMemoryUsageStore();
    await expect(s.consume("k", amount, limit, future())).rejects.toThrow();
    expect((await s.consume("k", 1, 1, future())).allowed).toBe(true); // counter untouched
  });
  it.each([["in the past", -1], ["now", 0], ["NaN", Number.NaN]])("rejects an expiry %s", async (_n, delta) => {
    const s = new InMemoryUsageStore(() => 1_000_000);
    await expect(s.consume("k", 1, 5, Number.isNaN(delta) ? Number.NaN : 1_000_000 + delta)).rejects.toThrow();
  });
  it.each([["unset", undefined], ["staging", "staging"], ["empty", ""]])("the in-memory store is refused when NODE_ENV is %s", (_n, nodeEnv) => {
    expect(readUsageConfig({ NODE_ENV: nodeEnv, GEMINI_ENABLED: "true", USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10" })).toEqual({
      ok: false,
      failure: "usage_store_unavailable",
    });
  });
});

// ---------------------------------------------------------------------------
describe("m2: the reservation hook is mandatory", () => {
  it("a caller that omits it does not compile, and at runtime no model call happens", async () => {
    const { model, calls } = counting();
    // @ts-expect-error — reserveAttempt is required
    const r = await analyzeWithGemini(model, CFG, { image: fakeJpeg(), mimeType: "image/jpeg", userLang: "ja", storeLang: "en", allergens: ["peanut"] }, { requestId: "r" });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED" });
    expect(calls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("m3: upstream values are allow-listed before logging", () => {
  it("unknown finishReason / blockReason from the SDK are reduced to 'unknown'", async () => {
    const factory = (() => ({
      models: { generateContent: async () => ({ text: "{}", candidates: [{ finishReason: "SYNTHETIC_SECRET_TOKEN" }], promptFeedback: { blockReason: "SYNTHETIC_SECRET_TOKEN" } }) },
    })) as never;
    const r = await createVertexMenuModel(CFG, factory).generate(
      { image: fakeJpeg(), mimeType: "image/jpeg", userLang: "ja", storeLang: "en", allergens: ["peanut"] },
      { signal: new AbortController().signal, timeoutMs: 100 },
    );
    expect(r.finishReason).toBe("unknown");
    expect(r.blockReason).toBe("unknown");
  });

  it("SYNTHETIC_SECRET_TOKEN never reaches a log line, even if passed in any field", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.map(String).join(" ")));
    const model: MenuModel = { generate: async () => ({ text: "{}", finishReason: "SYNTHETIC_SECRET_TOKEN", blockReason: "SYNTHETIC_SECRET_TOKEN" }) };
    const g = new UsageGuard(new InMemoryUsageStore(), { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 });
    await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g });
    const direct = sanitizeLogEvent({
      event: "analyze_menu",
      requestId: "r",
      outcome: "error",
      errorCode: "SYNTHETIC_SECRET_TOKEN",
      reason: "SYNTHETIC_SECRET_TOKEN",
      failure: "SYNTHETIC_SECRET_TOKEN",
      finishReason: "SYNTHETIC_SECRET_TOKEN",
      limitReason: "SYNTHETIC_SECRET_TOKEN",
    });
    expect(lines.join("\n") + JSON.stringify(direct)).not.toContain("SYNTHETIC_SECRET_TOKEN");
  });
});

describe("m3: allow-lists stay in sync with the code and the SDK", () => {
  it("every SDK finish/block reason is allow-listed", async () => {
    const { FinishReason, BlockedReason } = await import("@google/genai");
    const { LOG_FINISH_REASONS } = await import("@/server/log");
    for (const v of [...Object.values(FinishReason), ...Object.values(BlockedReason)]) {
      expect(LOG_FINISH_REASONS as readonly string[]).toContain(v);
    }
  });
  it("every failure literal in src/server is allow-listed (no silent 'unknown')", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { LOG_FAILURES } = await import("@/server/log");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src/server"));
    const literals = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/failure: "([a-z_]+)"/g)) literals.add(m[1]!);
      for (const m of src.matchAll(/fail\("AI_FAILED", "([a-z_]+)"/g)) literals.add(m[1]!);
      for (const m of src.matchAll(/disabled\("([a-z_]+)"\)/g)) literals.add(m[1]!);
      for (const m of src.matchAll(/stop = "([a-z_]+)"/g)) literals.add(m[1]!);
    }
    expect(literals.size).toBeGreaterThan(20);
    for (const l of literals) expect(LOG_FAILURES as readonly string[]).toContain(l);
  });
});

describe("M2: the runner bounds even a reservation hook that ignores the deadline", () => {
  it("a hook that never resolves → AI_DISABLED within the deadline, 0 model calls", async () => {
    const { model, calls } = counting();
    const t0 = Date.now();
    const r = await analyzeWithGemini(
      model,
      { ...CFG, requestDeadlineMs: 1_300, attemptTimeoutMs: 1_000 },
      { image: fakeJpeg(), mimeType: "image/jpeg", userLang: "ja", storeLang: "en", allergens: ["peanut"] },
      { requestId: "r", deadlineAt: Date.now() + 1_300, reserveAttempt: () => new Promise(() => {}) },
    );
    expect(Date.now() - t0).toBeLessThan(1_900);
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_timeout", attempts: 0 });
    expect(calls()).toBe(0);
  });
  it("a hook that rejects → AI_DISABLED (usage_store_error), 0 model calls", async () => {
    const { model, calls } = counting();
    const r = await analyzeWithGemini(
      model,
      CFG,
      { image: fakeJpeg(), mimeType: "image/jpeg", userLang: "ja", storeLang: "en", allergens: ["peanut"] },
      { requestId: "r", reserveAttempt: () => Promise.reject(new Error("SYNTHETIC_SECRET_TOKEN")) },
    );
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error" });
    expect(calls()).toBe(0);
  });
});
