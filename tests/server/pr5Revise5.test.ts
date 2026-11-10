import { GoogleAuth } from "google-auth-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzeMenuErrorSchema, AnalyzeMenuResponseSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import { createGuardedFetch, createVertexMenuModel } from "@/server/gemini/vertexClient";
import { sanitizeLogEvent, type LogEvent } from "@/server/log";
import { blob, fakeJpeg, testUsageGuard, PERMIT } from "./helpers";

/*
 * PR5 final audit: explicit `promptFeedback: null` in the RAW Vertex AI response.
 * @google/genai 2.30.0 drops top-level null fields while converting the response,
 * so the check must run on the raw HTTP body, before the SDK sees it.
 * These tests go through the REAL SDK; only the network (global fetch) and ADC
 * (GoogleAuth) are stubbed. All model outputs are SYNTHETIC.
 */

const ON: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 2000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const GOOD_TEXT = JSON.stringify({
  status: "ok",
  imageIssues: [],
  items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
  menuNotices: [],
});
const CANDIDATES = `[{"content":{"role":"model","parts":[{"text":${JSON.stringify(GOOD_TEXT)}}]},"finishReason":"STOP"}]`;
const raw = (extra: string) => `{"candidates":${CANDIDATES}${extra}}`;
const allow: ReserveAttempt = async () => PERMIT;

let rawBody: string;
let status: number;
let fetchCalls: string[];
let consoleOut: string[];

beforeEach(() => {
  rawBody = raw("");
  status = 200;
  fetchCalls = [];
  consoleOut = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a) => void consoleOut.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
  }
  vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers({ authorization: "Bearer FAKE-ADC-TOKEN" }) as never);
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    return new Response(rawBody, { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const run = () => analyzeWithGemini(createVertexMenuModel(CFG), CFG, REQ, { requestId: "r", reserveAttempt: allow }, { sleep: async () => {} });

function request(): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}
async function viaHandler(env: AnalyzeEnv = ON, withGuard = true) {
  const logs: LogEvent[] = [];
  const res = await handleAnalyzeMenu(request(), env, {
    model: createVertexMenuModel(CFG),
    config: CFG,
    ...(withGuard ? { usage: testUsageGuard() } : {}),
    logger: (e) => logs.push(e),
    sleep: async () => {},
  });
  return { res, logs };
}

// ---------------------------------------------------------------------------
describe("explicit null in the raw response (real SDK, stubbed network)", () => {
  it("audit repro: promptFeedback: null with a valid candidate → AI_FAILED, not HTTP 200, no retry", async () => {
    rawBody = raw(',"promptFeedback":null');
    const { res, logs } = await viaHandler();
    expect(res.status).not.toBe(200);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ outcome: "error", errorCode: "AI_FAILED", failure: "raw_response_rejected", attempts: 1 });
    expect(fetchCalls).toHaveLength(1);
    expect(consoleOut).toEqual([]);
  });

  it("promptFeedback omitted → the normal JSON is answered with HTTP 200 (contract-valid)", async () => {
    const { res, logs } = await viaHandler();
    expect(res.status).toBe(200);
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.dataOrigin).toBe("ai_analysis");
    expect(body.items[0]!.allergens.every((a) => a.confirmationRequired === true)).toBe(true);
    expect(logs[0]).toMatchObject({ outcome: "ok", attempts: 1 });
    expect(fetchCalls).toHaveLength(1);
    expect(consoleOut).toEqual([]);
  });

  it.each([
    ["candidates: null", '{"candidates":null,"promptFeedback":{}}'],
    ["usageMetadata: null next to valid candidates", raw(',"usageMetadata":null')],
    ["a duplicated promptFeedback key (the SDK's JSON.parse keeps the last)", raw(',"promptFeedback":{"blockReason":"SAFETY"},"promptFeedback":{}')],
    ["a duplicated candidates key", `{"candidates":[],"candidates":${CANDIDATES}}`],
    ["a top-level array", `[${raw("")}]`],
    ["invalid JSON", '{"candidates":'],
    ["two JSON documents", `${raw("")}${raw("")}`],
  ])("%s → AI_FAILED (raw_response_rejected, before the SDK converts it), one fetch only", async (_n, body) => {
    rawBody = body;
    expect(await run()).toMatchObject({ ok: false, code: "AI_FAILED", failure: "raw_response_rejected", attempts: 1 });
    expect(fetchCalls).toHaveLength(1);
    expect(consoleOut).toEqual([]);
  });

  it("an oversized raw response → AI_FAILED (raw_response_too_large), no retry", async () => {
    rawBody = raw(`,"usageMetadata":{"x":"${"a".repeat(4 * 1024 * 1024)}"}`);
    expect(await run()).toMatchObject({ ok: false, code: "AI_FAILED", failure: "raw_response_too_large", attempts: 1 });
    expect(fetchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("strict promptFeedback checks still apply through the real SDK", () => {
  it.each([
    ['"SAFETY"', '"SAFETY"'],
    ["an array", '[{"blockReason":"SAFETY"}]'],
    ["a number", "1"],
    ["a boolean", "true"],
    ["an unknown field", '{"SYNTHETIC_SECRET_TOKEN":"SYNTHETIC_SECRET_VALUE"}'],
    ["blockReason: null", '{"blockReason":null}'],
    ["safetyRatings not an array", '{"safetyRatings":"x"}'],
    ["a safety rating with an unknown field", '{"safetyRatings":[{"category":"HARM_CATEGORY_HATE_SPEECH","SYNTHETIC_SECRET_TOKEN":1}]}'],
    ["a blocked safety rating without blockReason", '{"safetyRatings":[{"category":"HARM_CATEGORY_HATE_SPEECH","blocked":true}]}'],
  ])("promptFeedback %s → AI_FAILED, one fetch, nothing on the console", async (_n, fb) => {
    rawBody = raw(`,"promptFeedback":${fb}`);
    expect(await run()).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1 });
    expect(fetchCalls).toHaveLength(1);
    expect(consoleOut).toEqual([]);
  });

  it.each(["SAFETY", "PROHIBITED_CONTENT", "JAILBREAK"])("a known block reason %s is still blocked", async (reason) => {
    rawBody = `{"promptFeedback":{"blockReason":"${reason}","blockReasonMessage":"SYNTHETIC"}}`;
    expect(await run()).toMatchObject({ ok: false, code: "AI_FAILED", failure: "blocked", finishReason: reason });
  });

  it("normal promptFeedback with non-blocking ratings → accepted", async () => {
    rawBody = raw(',"promptFeedback":{"safetyRatings":[{"category":"HARM_CATEGORY_HATE_SPEECH","probability":"NEGLIGIBLE","blocked":false}]},"usageMetadata":{"promptTokenCount":10}');
    expect(await run()).toMatchObject({ ok: true, attempts: 1 });
  });

  it("finishReason checks are unchanged (SAFETY → finish_not_stop, unknown → \"unknown\")", async () => {
    rawBody = raw("").replace('"finishReason":"STOP"', '"finishReason":"SAFETY"');
    expect(await run()).toMatchObject({ ok: false, failure: "finish_not_stop", finishReason: "SAFETY" });
    rawBody = raw("").replace('"finishReason":"STOP"', '"finishReason":"SYNTHETIC_SECRET_TOKEN"');
    expect(await run()).toMatchObject({ ok: false, failure: "finish_not_stop", finishReason: "unknown" });
  });

  it("an unknown part key still never reaches the console (no SDK response.text warning)", async () => {
    rawBody = `{"candidates":[{"content":{"parts":[{"text":${JSON.stringify(GOOD_TEXT)},"SYNTHETIC_SECRET_TOKEN":1}]},"finishReason":"STOP"}]}`;
    expect(await run()).toMatchObject({ ok: false, failure: "unexpected_part" });
    expect(consoleOut).toEqual([]);
  });

  it("secret strings in a rejected raw response reach neither logs nor console", async () => {
    rawBody = raw(',"promptFeedback":null,"SYNTHETIC_SECRET_TOKEN":"SYNTHETIC_SECRET_VALUE"');
    const { logs } = await viaHandler();
    const logged = JSON.stringify(logs.map(sanitizeLogEvent));
    expect(logged).not.toMatch(/SYNTHETIC|Satay|peanut/);
    expect(consoleOut).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("only successful generateContent responses are inspected; other guards unchanged", () => {
  it("a transient 503 is still retried exactly once (error bodies are not parsed as model output)", async () => {
    status = 503;
    rawBody = '{"error":{"code":503,"message":"SYNTHETIC_SECRET_TOKEN","status":"UNAVAILABLE"}}';
    expect(await run()).toMatchObject({ ok: false, failure: "upstream_transient", attempts: 2 });
    expect(fetchCalls).toHaveLength(2);
  });

  it("a 503 whose body has explicit nulls is not inspected: still a transient error, retried once", async () => {
    status = 503;
    rawBody = '{"error":null,"promptFeedback":null}';
    expect(await run()).toMatchObject({ ok: false, failure: "upstream_transient", attempts: 2 });
    expect(fetchCalls).toHaveLength(2);
  });

  it("an endless streamed body is cut off at the byte bound (memory stays bounded)", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const base = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++;
            c.enqueue(chunk);
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const g = createGuardedFetch("asia-northeast1", base);
    await expect(
      g("https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/asia-northeast1/publishers/google/models/m:generateContent", { method: "POST" }),
    ).rejects.toMatchObject({ name: "UnsafeRawResponseError", reason: "raw_response_too_large" });
    expect(pulled).toBeLessThanOrEqual(8);
  }, 5_000);

  it("a declared Content-Length over the bound is refused without reading the body", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const base = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++; // a stream pulls once eagerly when constructed (highWaterMark 1)
            c.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } },
      )) as unknown as typeof fetch;
    const g = createGuardedFetch("asia-northeast1", base);
    await expect(
      g("https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/asia-northeast1/publishers/google/models/m:generateContent", { method: "POST" }),
    ).rejects.toMatchObject({ reason: "raw_response_too_large" });
    expect(pulled).toBeLessThanOrEqual(1); // the body was not read on our side
  });

  it("the guarded fetch leaves other URLs and non-POST requests untouched", async () => {
    const seen: string[] = [];
    const base = (async (input: string) => (seen.push(input), new Response('{"promptFeedback":null}', { status: 200 }))) as unknown as typeof fetch;
    const g = createGuardedFetch("asia-northeast1", base);
    const other = await g("https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/publishers/google/models/m:countTokens", { method: "POST" });
    expect(await other.text()).toBe('{"promptFeedback":null}');
    const get = await g("https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/publishers/google/models/m:generateContent", { method: "GET" });
    expect(await get.text()).toBe('{"promptFeedback":null}');
    expect(seen).toHaveLength(2);
  });

  it("the guarded fetch hands the SDK an equivalent body for an accepted response", async () => {
    const body = raw(',"usageMetadata":{"promptTokenCount":1}');
    const base = (async () => new Response(body, { status: 200, headers: { "content-type": "application/json", "x-test": "1" } })) as unknown as typeof fetch;
    const g = createGuardedFetch("asia-northeast1", base);
    const res = await g("https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/asia-northeast1/publishers/google/models/m:generateContent", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-test")).toBe("1");
    expect(await res.json()).toEqual(JSON.parse(body));
  });

  it("a different host is still refused before any request (no token leaves)", async () => {
    const g = createGuardedFetch("asia-northeast1", (async () => new Response("{}")) as unknown as typeof fetch);
    await expect(g("https://example.com/v1/x:generateContent", { method: "POST" })).rejects.toThrow("endpoint not allowed");
  });

  it("production without a shared store: AI_DISABLED and ZERO network calls", async () => {
    const { res, logs } = await viaHandler({ ...ON, DAILY_INFERENCE_LIMIT: "10" }, false);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(logs[0]).toMatchObject({ outcome: "error", errorCode: "AI_DISABLED" });
    expect(fetchCalls).toHaveLength(0);
  });
});
