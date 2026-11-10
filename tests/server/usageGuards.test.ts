import { ApiError } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyzeMenuErrorSchema, AnalyzeMenuResponseSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import type { MenuModel, ModelCallResult } from "@/server/gemini/vertexClient";
import type { LogEvent } from "@/server/log";
import { UsageGuard, clientKey, jstDayEndMs, jstDayKey, readUsageConfig, type UsageLimits } from "@/server/usage/guard";
import { InMemoryUsageStore, type UsageStore } from "@/server/usage/store";
import { blob, fakeJpeg } from "./helpers";

/*
 * PR5: kill switch, rate limit, daily inference cap. All model outputs are
 * SYNTHETIC; the model, the ADC client and the network are test doubles.
 */

const CFG: GeminiConfig = { project: "proj-x", location: "asia-northeast1", model: "model-y", attemptTimeoutMs: 1000, requestDeadlineMs: 10_000, maxOutputTokens: 4096 };
const ON: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const GOOD = {
  status: "ok",
  imageIssues: [],
  items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
  menuNotices: [],
};
const ok = (): ModelCallResult => ({ text: JSON.stringify(GOOD), finishReason: "STOP" });

function countingModel(behaviour: (n: number) => Promise<ModelCallResult> = async () => ok()) {
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

function guard(limits: Partial<UsageLimits> = {}, store: UsageStore = new InMemoryUsageStore(), now?: () => number) {
  return new UsageGuard(store, { dailyInferenceLimit: 100, ratePerMinute: 60, trustedProxyHops: 0, ...limits }, now);
}

async function code(res: Response) {
  return AnalyzeMenuErrorSchema.parse(await res.json()).error.code;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kill switch", () => {
  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["upper-case TRUE", "TRUE"],
    ["1", "1"],
    ["yes", "yes"],
    ["padded", " true"],
    ["empty", ""],
  ])("GEMINI_ENABLED %s → AI_DISABLED with 0 model calls", async (_n, value) => {
    const { model, calls } = countingModel();
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), { NODE_ENV: "production", GEMINI_ENABLED: value }, {
      model,
      config: CFG,
      usage: guard(),
      logger: (e) => logs.push(e),
    });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("AI_DISABLED");
    expect(calls()).toBe(0);
    expect(logs[0]).toMatchObject({ failure: "kill_switch_off" });
  });

  it("with the switch off, no SDK client is built and no ADC token is requested (env config)", async () => {
    const auth = vi.spyOn(GoogleAuth.prototype, "getRequestHeaders");
    const net = vi.fn();
    vi.stubGlobal("fetch", net);
    const env = { NODE_ENV: "production", GEMINI_ENABLED: "false", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "asia-northeast1", GEMINI_MODEL: "m", USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10" };
    const res = await handleAnalyzeMenu(request(), env, { logger: () => {} });
    expect(await code(res)).toBe("AI_DISABLED");
    expect(auth).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
  });

  it("does not affect development mock mode (Mock never calls Gemini)", async () => {
    const { model, calls } = countingModel();
    const res = await handleAnalyzeMenu(request(), { NODE_ENV: "development", MOCK_GEMINI: "true" }, { model, logger: () => {} });
    expect(res.status).toBe(200);
    expect(AnalyzeMenuResponseSchema.parse(await res.json()).dataOrigin).toBe("mock_fixture");
    expect(calls()).toBe(0);
  });

  it("production never serves mock data, even with MOCK_GEMINI=true and the switch on", async () => {
    const { model, calls } = countingModel();
    const res = await handleAnalyzeMenu(request(), { ...ON, MOCK_GEMINI: "true" }, { model, config: CFG, usage: guard(), logger: () => {} });
    expect(AnalyzeMenuResponseSchema.parse(await res.json()).dataOrigin).toBe("ai_analysis");
    expect(calls()).toBe(1);
  });

  it("card_only rejects before invalid input validation (503)", async () => {
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "fr");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const res = await handleAnalyzeMenu(new Request("http://localhost/x", { method: "POST", body: f }), { NODE_ENV: "production" }, { logger: () => {} });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("AI_DISABLED");
  });
});

describe("fail-closed configuration (no model call, no ADC token)", () => {
  const BASE = { NODE_ENV: "production", GEMINI_ENABLED: "true", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "asia-northeast1", GEMINI_MODEL: "m" };
  it.each([
    ["no USAGE_STORE", { DAILY_INFERENCE_LIMIT: "10" }, "usage_store_unavailable"],
    ["unsupported store (not yet approved)", { USAGE_STORE: "firestore", DAILY_INFERENCE_LIMIT: "10" }, "usage_store_unavailable"],
    ["store name in another case", { USAGE_STORE: "Memory", DAILY_INFERENCE_LIMIT: "10" }, "usage_store_unavailable"],
    ["in-memory store in production", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10" }, "usage_store_unavailable"],
    ["no daily limit", { USAGE_STORE: "memory" }, "usage_config_invalid"],
    ["daily limit 0", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "0" }, "usage_config_invalid"],
    ["daily limit negative", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "-5" }, "usage_config_invalid"],
    ["daily limit not an integer", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "1e3" }, "usage_config_invalid"],
    ["daily limit above bound", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10001" }, "usage_config_invalid"],
    ["rate limit invalid", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10", RATE_LIMIT_PER_MINUTE: "abc" }, "usage_config_invalid"],
    ["rate limit 0", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10", RATE_LIMIT_PER_MINUTE: "0" }, "usage_config_invalid"],
    ["proxy hops invalid", { USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10", TRUSTED_PROXY_HOPS: "9" }, "usage_config_invalid"],
  ])("%s → AI_DISABLED (%s)", async (_n, extra, failure) => {
    const auth = vi.spyOn(GoogleAuth.prototype, "getRequestHeaders");
    const net = vi.fn();
    vi.stubGlobal("fetch", net);
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), { ...BASE, ...extra } as AnalyzeEnv, { logger: (e) => logs.push(e) });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("AI_DISABLED");
    expect(logs[0]).toMatchObject({ failure });
    expect(auth).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
  });

  it("the in-memory store is accepted only outside production (development/test)", () => {
    const env = { GEMINI_ENABLED: "true", USAGE_STORE: "memory", DAILY_INFERENCE_LIMIT: "10" };
    expect(readUsageConfig({ ...env, NODE_ENV: "development" }).ok).toBe(true);
    expect(readUsageConfig({ ...env, NODE_ENV: "test" }).ok).toBe(true);
    expect(readUsageConfig({ ...env, NODE_ENV: "production" })).toEqual({ ok: false, failure: "usage_store_unavailable" });
  });

  it("a store error fails closed (AI_DISABLED, 0 model calls)", async () => {
    const broken: UsageStore = { kind: "broken", consume: async () => Promise.reject(new Error("store down: secret-detail")) };
    const { model, calls } = countingModel();
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: guard({}, broken), logger: (e) => logs.push(e) });
    expect(await code(res)).toBe("AI_DISABLED");
    expect(calls()).toBe(0);
    expect(JSON.stringify(logs)).not.toContain("secret-detail");
  });
});

describe("daily inference cap", () => {
  it("at the cap → AI_DISABLED with 0 model calls", async () => {
    const g = guard({ dailyInferenceLimit: 2 });
    const { model, calls } = countingModel();
    const logs: LogEvent[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, logger: (e) => logs.push(e) })).status);
    }
    expect(statuses).toEqual([200, 200, 503, 503]);
    expect(calls()).toBe(2);
    expect(logs[2]).toMatchObject({ errorCode: "AI_DISABLED", failure: "daily_limit_reached", attempts: 0, reserved: 0 });
  });

  it("concurrent requests can never exceed the cap", async () => {
    const g = guard({ dailyInferenceLimit: 3 });
    const { model, calls } = countingModel(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok();
    });
    const results = await Promise.all(
      Array.from({ length: 25 }, () => handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, logger: () => {} })),
    );
    const statuses = results.map((r) => r.status);
    expect(calls()).toBe(3);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 503)).toHaveLength(22);
  });

  it("the retry also reserves a unit: with 1 unit left, a failing call is NOT retried", async () => {
    const g = guard({ dailyInferenceLimit: 1 });
    const { model, calls } = countingModel(async (n) => {
      if (n === 1) throw new ApiError({ message: "unavailable", status: 503 });
      return ok();
    });
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, logger: (e) => logs.push(e), sleep: async () => {} });
    expect(res.status).toBe(502);
    expect(await code(res)).toBe("AI_FAILED"); // the first attempt's error, unchanged
    expect(calls()).toBe(1);
    expect(logs[0]).toMatchObject({ attempts: 1, reserved: 1, limitReason: "retry_daily_limit_reached" });
  });

  it("with 2 units, the retry runs and consumes the second unit", async () => {
    const store = new InMemoryUsageStore();
    const g = guard({ dailyInferenceLimit: 2 }, store);
    const { model, calls } = countingModel(async (n) => {
      if (n === 1) throw new ApiError({ message: "unavailable", status: 503 });
      return ok();
    });
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, logger: (e) => logs.push(e), sleep: async () => {} });
    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
    expect(logs[0]).toMatchObject({ attempts: 2, reserved: 2 });
    // nothing left for the next request
    expect((await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, logger: () => {} })).status).toBe(503);
  });

  it("failed and timed-out calls are never refunded", async () => {
    const g = guard({ dailyInferenceLimit: 2 });
    const { model: failing } = countingModel(async () => {
      throw new ApiError({ message: "bad", status: 400 }); // not retried
    });
    expect((await handleAnalyzeMenu(request(), ON, { model: failing, config: CFG, usage: g, logger: () => {} })).status).toBe(502);
    const hanging: MenuModel = { generate: () => new Promise<never>(() => {}) };
    expect((await handleAnalyzeMenu(request(), ON, { model: hanging, config: { ...CFG, attemptTimeoutMs: 20 }, usage: g, logger: () => {} })).status).toBe(504);
    const { model, calls } = countingModel();
    expect((await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: g, logger: () => {} })).status).toBe(503);
    expect(calls()).toBe(0);
  });

  it("a store error when reserving the retry stops the retry (fail closed)", async () => {
    let n = 0;
    const flaky: UsageStore = {
      kind: "flaky",
      consume: async (key, amount, limit, exp) => {
        if (key.startsWith("daily:") && ++n === 2) throw new Error("down");
        return new InMemoryUsageStore().consume(key, amount, limit, exp);
      },
    };
    const { model, calls } = countingModel(async () => {
      throw new ApiError({ message: "unavailable", status: 503 });
    });
    const logs: LogEvent[] = [];
    await handleAnalyzeMenu(request(), ON, { model, config: CFG, usage: guard({}, flaky), logger: (e) => logs.push(e), sleep: async () => {} });
    expect(calls()).toBe(1);
    expect(logs[0]).toMatchObject({ limitReason: "retry_usage_store_error" });
  });

  it("resets at 00:00 Japan Standard Time", () => {
    expect(jstDayKey(Date.parse("2026-11-05T14:59:59.999Z"))).toBe("2026-11-05"); // 23:59:59 JST
    expect(jstDayKey(Date.parse("2026-11-05T15:00:00.000Z"))).toBe("2026-11-06"); // 00:00 JST
    expect(jstDayEndMs(Date.parse("2026-11-05T03:00:00Z"))).toBe(Date.parse("2026-11-05T15:00:00Z"));
  });

  it("a new JST day starts a new counter", async () => {
    let t = Date.parse("2026-11-05T14:59:00Z");
    const store = new InMemoryUsageStore(() => t);
    const g = guard({ dailyInferenceLimit: 1 }, store, () => t);
    expect((await g.reserveInference()).decision).toBe("allowed");
    expect((await g.reserveInference()).decision).toBe("limited");
    t = Date.parse("2026-11-05T15:00:01Z");
    expect((await g.reserveInference()).decision).toBe("allowed");
  });
});

describe("rate limit", () => {
  it("limits one client to N requests per minute (RATE_LIMITED, 0 model calls beyond the limit)", async () => {
    const g = guard({ ratePerMinute: 2, trustedProxyHops: 1 });
    const { model, calls } = countingModel();
    const logs: LogEvent[] = [];
    const st: number[] = [];
    for (let i = 0; i < 3; i++) st.push((await handleAnalyzeMenu(request("203.0.113.7"), ON, { model, config: CFG, usage: g, logger: (e) => logs.push(e) })).status);
    expect(st).toEqual([200, 200, 429]);
    expect(calls()).toBe(2);
    expect(logs[2]).toMatchObject({ errorCode: "RATE_LIMITED", failure: "rate_limited" });
  });

  it("different clients have separate buckets (with a trusted proxy hop)", async () => {
    const g = guard({ ratePerMinute: 1, trustedProxyHops: 1 });
    const { model } = countingModel();
    const d = { model, config: CFG, usage: g, logger: () => {} };
    expect((await handleAnalyzeMenu(request("203.0.113.7"), ON, d)).status).toBe(200);
    expect((await handleAnalyzeMenu(request("198.51.100.9"), ON, d)).status).toBe(200);
    expect((await handleAnalyzeMenu(request("203.0.113.7"), ON, d)).status).toBe(429);
  });

  it("client-supplied X-Forwarded-For entries cannot create new buckets", async () => {
    const g = guard({ ratePerMinute: 1, trustedProxyHops: 1 });
    const { model } = countingModel();
    const d = { model, config: CFG, usage: g, logger: () => {} };
    expect((await handleAnalyzeMenu(request("1.1.1.1, 203.0.113.7"), ON, d)).status).toBe(200);
    expect((await handleAnalyzeMenu(request("2.2.2.2, 203.0.113.7"), ON, d)).status).toBe(429); // same real client
  });

  it("without a trusted proxy hop everyone shares one bucket (fails safe)", async () => {
    const g = guard({ ratePerMinute: 1, trustedProxyHops: 0 });
    const { model } = countingModel();
    const d = { model, config: CFG, usage: g, logger: () => {} };
    expect((await handleAnalyzeMenu(request("203.0.113.7"), ON, d)).status).toBe(200);
    expect((await handleAnalyzeMenu(request("198.51.100.9"), ON, d)).status).toBe(429);
  });

  it("the window resets after a minute", async () => {
    let t = Date.parse("2026-11-05T03:00:10Z");
    const g = guard({ ratePerMinute: 1 }, new InMemoryUsageStore(() => t), () => t);
    expect(await g.checkRate("c")).toBe("allowed");
    expect(await g.checkRate("c")).toBe("limited");
    t += 60_000;
    expect(await g.checkRate("c")).toBe("allowed");
  });

  it("client keys: hashed, IPv6 grouped by /64, invalid or missing → unidentified", () => {
    const k = (xff: string | undefined, hops = 1) => clientKey(request(xff), hops);
    expect(k("203.0.113.7")).toMatch(/^c_[0-9a-f]{32}$/);
    expect(k("203.0.113.7")).not.toContain("203.0.113.7");
    expect(k("2001:db8:1:2:aaaa::1")).toBe(k("2001:db8:1:2:bbbb::2"));
    expect(k("2001:db8:1:2::1")).not.toBe(k("2001:db8:1:3::1"));
    expect(k("not-an-ip")).toBe("unidentified");
    expect(k(undefined)).toBe("unidentified");
    expect(k("203.0.113.7", 2)).toBe("unidentified"); // header shorter than the trusted hops
    expect(k("203.0.113.7", 0)).toBe("unidentified");
  });
});

describe("usage store contract (any implementation must pass; reuse for a shared store)", () => {
  const stores: [string, () => UsageStore][] = [["InMemoryUsageStore", () => new InMemoryUsageStore()]];
  describe.each(stores)("%s", (_n, make) => {
    it("allows up to the limit and never exceeds it", async () => {
      const s = make();
      const r = [];
      for (let i = 0; i < 5; i++) r.push(await s.consume("k", 1, 3, Date.now() + 60_000));
      expect(r.map((x) => x.allowed)).toEqual([true, true, true, false, false]);
      expect(r[4]!.count).toBe(3); // denied calls do not increment
    });
    it("is atomic under concurrent calls", async () => {
      const s = make();
      const r = await Promise.all(Array.from({ length: 50 }, () => s.consume("c", 1, 7, Date.now() + 60_000)));
      expect(r.filter((x) => x.allowed)).toHaveLength(7);
    });
    it("keeps separate keys separate", async () => {
      const s = make();
      await s.consume("a", 1, 1, Date.now() + 60_000);
      expect((await s.consume("b", 1, 1, Date.now() + 60_000)).allowed).toBe(true);
    });
  });
});

describe("logs", () => {
  it("never contain the client address, X-Forwarded-For, image data or store errors", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.map(String).join(" ")));
    const g = guard({ ratePerMinute: 1, dailyInferenceLimit: 1, trustedProxyHops: 1 });
    const { model } = countingModel();
    for (let i = 0; i < 2; i++) await handleAnalyzeMenu(request("203.0.113.77, 198.51.100.99"), ON, { model, config: CFG, usage: g });
    const all = lines.join("\n");
    expect(lines).toHaveLength(2);
    for (const forbidden of ["203.0.113.77", "198.51.100.99", "c_", "proj-x", "peanut", "Satay"]) expect(all).not.toContain(forbidden);
    for (const line of lines) {
      for (const key of Object.keys(JSON.parse(line))) {
        expect(["event", "requestId", "outcome", "errorCode", "reason", "failure", "upstreamStatus", "finishReason", "attempts", "reserved", "reservationsUnknown", "reservationsRolledOver", "limitReason", "latencyMs", "mock"]).toContain(key);
      }
    }
  });
});
