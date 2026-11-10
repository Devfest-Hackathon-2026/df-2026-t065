import { ApiError } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyzeMenuErrorSchema, AnalyzeMenuResponseSchema, checkResponseInvariants } from "@/contracts/analyze";
import type { GeminiConfig } from "@/server/config";
import { handleAnalyzeMenu, type AnalyzeDeps, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { MenuModel, ModelCallResult, ModelRequest } from "@/server/gemini/vertexClient";
import type { LogEvent } from "@/server/log";
import { blob, fakeJpeg, fakePng, testUsageGuard } from "./helpers";

/*
 * Real Gemini path with a TEST DOUBLE in place of Vertex AI.
 * No test here calls a real API or needs credentials.
 * All model outputs below are SYNTHETIC test data.
 */

const PROD: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CONFIG: GeminiConfig = {
  project: "test-project",
  location: "test-location",
  model: "test-model",
  attemptTimeoutMs: 1_000,
  requestDeadlineMs: 10_000,
  maxOutputTokens: 4096,
};

type Step = ModelCallResult | Error | "hang";

/** Fake model that plays a script of results/errors, one per call, and records calls. */
function scriptedModel(...steps: Step[]) {
  const calls: ModelRequest[] = [];
  const model: MenuModel = {
    async generate(req, { signal }) {
      calls.push(req);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      if (step === "hang") {
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { model, calls };
}

function out(obj: unknown, finishReason = "STOP"): ModelCallResult {
  return { text: JSON.stringify(obj), finishReason };
}

const SECRET_MENU_TEXT = "Satay Skewers with peanut sauce";
const GOOD = {
  status: "ok",
  imageIssues: [],
  items: [
    {
      readText: SECRET_MENU_TEXT,
      readTextLang: "en",
      translation: "ピーナッツソースのサテ串",
      readability: "clear",
      allergens: [
        { code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" },
        { code: "soy", category: "ai_inferred", rationale: "Satay marinades often contain soy sauce." },
      ],
    },
  ],
  menuNotices: [],
};

function request(opts: { allergens?: string[]; image?: Blob; userLang?: string; storeLang?: string } = {}): Request {
  const f = new FormData();
  f.append("userLang", opts.userLang ?? "ja");
  f.append("storeLang", opts.storeLang ?? "en");
  for (const a of opts.allergens ?? ["peanut", "soy", "milk"]) f.append("allergens", a);
  f.append("image", opts.image ?? blob(fakeJpeg(), "image/jpeg"), "menu.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}

function deps(model: MenuModel, extra: Partial<AnalyzeDeps> = {}) {
  const logs: LogEvent[] = [];
  const d: AnalyzeDeps = {
    model,
    config: CONFIG,
    usage: testUsageGuard(),
    logger: (e) => logs.push(e),
    sleep: async () => {},
    newRequestId: () => "req-test",
    ...extra,
  };
  return { d, logs };
}

async function errorOf(res: Response) {
  return AnalyzeMenuErrorSchema.parse(await res.json()).error;
}

afterEach(() => vi.restoreAllMocks());

describe("successful analysis", () => {
  it("returns a contract-valid response from normal model output", async () => {
    const { model, calls } = scriptedModel(out(GOOD));
    const res = await handleAnalyzeMenu(request(), PROD, deps(model).d);
    expect(res.status).toBe(200);
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.dataOrigin).toBe("ai_analysis");
    expect(body.requestId).toBe("req-test");
    expect(checkResponseInvariants(body, ["peanut", "soy", "milk"])).toEqual([]);
    const item = body.items[0]!;
    expect(item.readText).toEqual({ text: SECRET_MENU_TEXT, lang: "en", readBy: "ai" });
    expect(item.aiTranslation).toEqual({ text: "ピーナッツソースのサテ串", lang: "ja", verified: false });
    expect(item.allergens.map((a) => a.code)).toEqual(["peanut", "soy", "milk"]);
    // milk was not returned by the model → filled in as unconfirmed, never as absent
    expect(item.allergens[2]).toEqual({ code: "milk", category: "unconfirmed", reason: "not_assessed", confirmationRequired: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mimeType).toBe("image/jpeg");
    expect(calls[0]!.allergens).toEqual(["peanut", "soy", "milk"]);
  });

  it("keeps absence_claim as a menu mention that still requires confirmation", async () => {
    const o = structuredClone(GOOD);
    o.items[0]!.readText = "Brownie (peanut-free)";
    o.items[0]!.allergens = [{ code: "peanut", category: "menu_mentions", mentionKind: "absence_claim", excerpt: "peanut-free" }];
    const res = await handleAnalyzeMenu(request({ allergens: ["peanut"] }), PROD, deps(scriptedModel(out(o)).model).d);
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.items[0]!.allergens[0]).toEqual({
      code: "peanut",
      category: "menu_mentions",
      mention: { kind: "absence_claim", excerpt: "peanut-free" },
      confirmationRequired: true,
    });
  });

  it("returns an unreadable result without items", async () => {
    const o = { status: "unreadable", imageIssues: ["blurry", "low_light"], items: [], menuNotices: [] };
    const res = await handleAnalyzeMenu(request(), PROD, deps(scriptedModel(out(o)).model).d);
    expect(res.status).toBe(200);
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "unreadable", items: [], imageIssues: ["blurry", "low_light"] });
  });

  it("drops allergens the model returned but the user did not select", async () => {
    const res = await handleAnalyzeMenu(request({ allergens: ["peanut"] }), PROD, deps(scriptedModel(out(GOOD)).model).d);
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.items[0]!.allergens.map((a) => a.code)).toEqual(["peanut"]);
  });

  it("accepts PNG input and passes the verified MIME type to the model", async () => {
    const { model, calls } = scriptedModel(out(GOOD));
    const res = await handleAnalyzeMenu(request({ image: blob(fakePng(), "image/png") }), PROD, deps(model).d);
    expect(res.status).toBe(200);
    expect(calls[0]!.mimeType).toBe("image/png");
  });
});

describe("invalid model output fails safe (AI_FAILED, no retry)", () => {
  const cases: [string, ModelCallResult][] = [
    ["non-JSON text", { text: "Sure! Here is the menu: ...", finishReason: "STOP" }],
    ["empty text", { text: "", finishReason: "STOP" }],
    ["missing text", { text: undefined, finishReason: "STOP" }],
    ["missing required field", out({ status: "ok", imageIssues: [], items: [] })],
    ["unknown top-level field (safe)", out({ ...GOOD, safe: true })],
    [
      "unknown field on an assessment (edible)",
      out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "unconfirmed", unconfirmedReason: "not_mentioned", edible: true }] }] }),
    ],
    ["unknown category (allergen_absent)", out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "allergen_absent" }] }] })],
    ["unsupported allergen code", out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "almond", category: "ai_inferred" }] }] })],
    [
      "menu_mentions without excerpt",
      out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim" }] }] }),
    ],
    [
      "unconfirmed carrying an excerpt",
      out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "unconfirmed", unconfirmedReason: "not_mentioned", excerpt: "peanut" }] }] }),
    ],
    [
      "unconfirmed without a reason",
      out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "unconfirmed" }] }] }),
    ],
    [
      "duplicate / conflicting assessments (contains vs absence)",
      out({
        ...GOOD,
        items: [
          {
            ...GOOD.items[0],
            readText: "Satay with peanut sauce (peanut-free option)",
            allergens: [
              { code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" },
              { code: "peanut", category: "menu_mentions", mentionKind: "absence_claim", excerpt: "peanut-free" },
            ],
          },
        ],
      }),
    ],
    [
      "unconfirmed vs contains for the same allergen",
      out({
        ...GOOD,
        items: [
          {
            ...GOOD.items[0],
            allergens: [
              { code: "peanut", category: "unconfirmed", unconfirmedReason: "not_mentioned" },
              { code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" },
            ],
          },
        ],
      }),
    ],
    [
      "excerpt not in readText",
      out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "lobster" }] }] }),
    ],
    [
      "whitespace-only excerpt",
      out({ ...GOOD, items: [{ ...GOOD.items[0], allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: " 　 " }] }] }),
    ],
    [
      "invisible-only readText and excerpt (U+2063 / U+200E)",
      out({
        ...GOOD,
        items: [
          {
            ...GOOD.items[0],
            readText: "⁣‎",
            allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "‎" }],
          },
        ],
      }),
    ],
    ["status unreadable but items present", out({ ...GOOD, status: "unreadable" })],
    ["too many items (31)", out({ ...GOOD, items: Array.from({ length: 31 }, () => GOOD.items[0]) })],
    ["finishReason MAX_TOKENS (truncated)", out(GOOD, "MAX_TOKENS")],
    ["finishReason SAFETY", out(GOOD, "SAFETY")],
    ["prompt blocked", { text: undefined, blockReason: "SAFETY" }],
  ];

  it.each(cases)("%s", async (_n, result) => {
    const { model, calls } = scriptedModel(result, out(GOOD));
    const res = await handleAnalyzeMenu(request(), PROD, deps(model).d);
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toEqual({ code: "AI_FAILED", retryable: true });
    expect(calls).toHaveLength(1); // invalid output is not retried (cost)
  });
});

describe("timeouts, retries and upstream errors", () => {
  it("times out a hanging model call (AI_TIMEOUT) and does not retry it", async () => {
    const { model, calls } = scriptedModel("hang");
    const res = await handleAnalyzeMenu(request(), PROD, deps(model, { config: { ...CONFIG, attemptTimeoutMs: 30 } }).d);
    expect(res.status).toBe(504);
    expect(await errorOf(res)).toEqual({ code: "AI_TIMEOUT", retryable: true });
    expect(calls).toHaveLength(1);
  });

  it("times out even if the SDK ignores the abort signal", async () => {
    const model: MenuModel = { generate: () => new Promise<never>(() => {}) };
    const res = await handleAnalyzeMenu(request(), PROD, deps(model, { config: { ...CONFIG, attemptTimeoutMs: 30 } }).d);
    expect((await errorOf(res)).code).toBe("AI_TIMEOUT");
  });

  it("retries ONCE after a transient 503 and succeeds", async () => {
    const { model, calls } = scriptedModel(new ApiError({ message: "unavailable", status: 503 }), out(GOOD));
    const { d, logs } = deps(model);
    const res = await handleAnalyzeMenu(request(), PROD, d);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(logs[0]).toMatchObject({ outcome: "ok", attempts: 2 });
  });

  it("gives up after one retry (at most 2 calls) when the error persists", async () => {
    const { model, calls } = scriptedModel(new ApiError({ message: "x", status: 503 }));
    const res = await handleAnalyzeMenu(request(), PROD, deps(model).d);
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toEqual({ code: "AI_FAILED", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it("retries once after a network error", async () => {
    const netErr = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const { model, calls } = scriptedModel(netErr, out(GOOD));
    expect((await handleAnalyzeMenu(request(), PROD, deps(model).d)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does not retry when the remaining deadline is too short", async () => {
    let t = Date.parse("2026-11-06T03:00:00Z");
    const { model, calls } = scriptedModel(new ApiError({ message: "x", status: 503 }), out(GOOD));
    const now = () => t;
    const slowModel: MenuModel = {
      async generate(req, o) {
        t += 9_000; // the first call used 9 s of a 10 s deadline
        return model.generate(req, o);
      },
    };
    // One clock for the handler, the runner and the usage guard.
    const res = await handleAnalyzeMenu(request(), PROD, deps(slowModel, { now, usage: testUsageGuard(now) }).d);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [429, "RATE_LIMITED", 429],
    [401, "AI_DISABLED", 503],
    [403, "AI_DISABLED", 503],
    [404, "AI_DISABLED", 503],
    [400, "AI_FAILED", 502],
  ] as const)("maps upstream HTTP %i to %s without retrying", async (status, code, http) => {
    const { model, calls } = scriptedModel(new ApiError({ message: "internal detail", status }), out(GOOD));
    const res = await handleAnalyzeMenu(request(), PROD, deps(model).d);
    expect(res.status).toBe(http);
    expect((await errorOf(res)).code).toBe(code);
    expect(calls).toHaveLength(1);
  });

  it("maps missing Application Default Credentials to AI_DISABLED without retrying", async () => {
    const { model, calls } = scriptedModel(new Error("Could not load the default credentials. Browse to https://..."));
    const res = await handleAnalyzeMenu(request(), PROD, deps(model).d);
    expect((await errorOf(res)).code).toBe("AI_DISABLED");
    expect(calls).toHaveLength(1);
  });

  it("never exposes upstream error details to the client", async () => {
    const { model } = scriptedModel(new ApiError({ message: "project secret-proj-123 quota exceeded", status: 429 }));
    const res = await handleAnalyzeMenu(request(), PROD, deps(model).d);
    const text = await res.text();
    expect(text).not.toContain("secret-proj-123");
    expect(text).not.toContain("quota");
    expect(JSON.parse(text)).toEqual({ requestId: "req-test", error: { code: "RATE_LIMITED", retryable: true } });
  });
});

describe("configuration and mock interaction", () => {
  it("returns AI_DISABLED and never calls a model when Gemini is not configured", async () => {
    const res = await handleAnalyzeMenu(request(), PROD, { logger: () => {} });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("AI_DISABLED");
  });

  it("does not use mock fixtures in production even with MOCK_GEMINI=true", async () => {
    const { model, calls } = scriptedModel(out(GOOD));
    const res = await handleAnalyzeMenu(request(), { NODE_ENV: "production", MOCK_GEMINI: "true", GEMINI_ENABLED: "true" }, deps(model).d);
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.dataOrigin).toBe("ai_analysis");
    expect(calls).toHaveLength(1);
  });

  it("uses mock fixtures (and not the model) in development with MOCK_GEMINI=true", async () => {
    const { model, calls } = scriptedModel(out(GOOD));
    const res = await handleAnalyzeMenu(request(), { NODE_ENV: "development", MOCK_GEMINI: "true" }, deps(model).d);
    expect(AnalyzeMenuResponseSchema.parse(await res.json()).dataOrigin).toBe("mock_fixture");
    expect(calls).toHaveLength(0);
  });
});

describe("invalid input never reaches the model", () => {
  it.each([
    ["disguised image (PNG bytes declared JPEG)", request({ image: blob(fakePng(), "image/jpeg") }), "unsupported_image_type"],
    ["text file declared JPEG", request({ image: blob(new TextEncoder().encode("hello"), "image/jpeg") }), "unsupported_image_type"],
    ["image over 4 MiB", request({ image: blob(fakeJpeg(4 * 1024 * 1024 + 1), "image/jpeg") }), "image_too_large"],
    ["unsupported language pair", request({ storeLang: "fr" }), "unsupported_language_pair"],
  ])("%s", async (_n, req, reason) => {
    const { model, calls } = scriptedModel(out(GOOD));
    const res = await handleAnalyzeMenu(req, PROD, deps(model).d);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: "INVALID_INPUT", retryable: false, reason });
    expect(calls).toHaveLength(0);
  });

  it("rejects a large body without Content-Length before the model is called", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const req = new Request("http://localhost/api/analyze-menu", {
      method: "POST",
      body: stream,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    const { model, calls } = scriptedModel(out(GOOD));
    const res = await handleAnalyzeMenu(req, PROD, deps(model).d);
    expect(await errorOf(res)).toEqual({ code: "INVALID_INPUT", retryable: false, reason: "image_too_large" });
    expect(calls).toHaveLength(0);
  });
});

describe("logs contain no image, menu text, AI output or personal data", () => {
  it("success and failure logs only carry allow-listed enum fields", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const imageBytes = fakeJpeg(256);
    imageBytes.set(new TextEncoder().encode("UNIQUEIMAGEMARKER"), 20);
    const base64 = Buffer.from(imageBytes).toString("base64");

    const scenarios: Step[] = [out(GOOD), out({ ...GOOD, safe: true }), new ApiError({ message: "detail-leak-xyz", status: 500 })];
    const logged: string[] = [];
    for (const step of scenarios) {
      const { model } = scriptedModel(step);
      // use the real console logger to check what would actually be written
      await handleAnalyzeMenu(request({ image: blob(imageBytes, "image/jpeg") }), PROD, {
        model,
        config: CONFIG,
        usage: testUsageGuard(),
        sleep: async () => {},
        newRequestId: () => "req-log",
      });
    }
    for (const call of consoleSpy.mock.calls) logged.push(call.map(String).join(" "));
    const all = logged.join("\n");
    expect(logged.length).toBe(3);
    for (const forbidden of [
      base64,
      base64.slice(0, 40),
      "UNIQUEIMAGEMARKER",
      SECRET_MENU_TEXT,
      "peanut sauce",
      "ピーナッツ",
      "Satay marinades",
      "detail-leak-xyz",
      '"peanut"',
      '"soy"',
      '"milk"',
    ]) {
      expect(all).not.toContain(forbidden);
    }
    for (const line of logged) {
      const keys = Object.keys(JSON.parse(line));
      for (const k of keys) {
        expect(["event", "requestId", "outcome", "errorCode", "reason", "failure", "upstreamStatus", "finishReason", "attempts", "reserved", "reservationsUnknown", "reservationsRolledOver", "limitReason", "latencyMs", "mock"]).toContain(k);
      }
    }
  });
});
