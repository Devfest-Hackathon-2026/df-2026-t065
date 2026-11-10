import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import { MAX_MODEL_JSON_BYTES, parseStrictJson } from "@/server/gemini/strictJson";
import { createVertexMenuModel, inspectModelResponse, type MenuModel } from "@/server/gemini/vertexClient";
import { sanitizeLogEvent, type LogEvent } from "@/server/log";
import { blob, fakeJpeg, testUsageGuard, PERMIT } from "./helpers";

/*
 * PR5 CONDITIONAL GO — required fixes before merge: (A) the JSON size limit is
 * measured in UTF-8 bytes, (B) SDK safety metadata (promptFeedback) is strictly
 * validated. SDK and model are test doubles. All model outputs are SYNTHETIC.
 */

const ON: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 5000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const GOOD_TEXT = JSON.stringify({
  status: "ok",
  imageIssues: [],
  items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
  menuNotices: [],
});
const LIMIT = 512 * 1024;
const allow: ReserveAttempt = async () => PERMIT;

/** A JSON string literal whose UTF-8 encoding is exactly `bytes` long, built from `unit`. */
function jsonStringOfBytes(unit: string, bytes: number): string {
  const unitBytes = Buffer.byteLength(unit, "utf8");
  const n = Math.floor((bytes - 2) / unitBytes);
  const pad = bytes - 2 - n * unitBytes; // ASCII filler for the remainder
  return `"${unit.repeat(n)}${"a".repeat(pad)}"`;
}

// ---------------------------------------------------------------------------
describe("A: the JSON size limit is measured in UTF-8 bytes", () => {
  it("the exported limit is 512 KiB", () => {
    expect(MAX_MODEL_JSON_BYTES).toBe(LIMIT);
  });

  it.each([
    ["ASCII", "a"],
    ["Japanese (3 bytes)", "漢"],
    ["2-byte Latin", "é"],
    ["surrogate pair (4 bytes)", "\u{1F95C}"],
  ])("%s: exactly 512 KiB is accepted, one byte more is rejected", (_n, unit) => {
    const at = jsonStringOfBytes(unit, LIMIT);
    expect(Buffer.byteLength(at, "utf8")).toBe(LIMIT);
    expect(parseStrictJson(at).ok).toBe(true);
    const over = jsonStringOfBytes(unit, LIMIT + 1);
    expect(Buffer.byteLength(over, "utf8")).toBe(LIMIT + 1);
    expect(parseStrictJson(over)).toEqual({ ok: false, issue: "too_large" });
  });

  it("audit repro: 174,763 × 「漢」 (524,289 bytes, 174,763 UTF-16 units) is rejected", () => {
    const text = "漢".repeat(174_763);
    expect(text.length).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(text, "utf8")).toBe(524_289);
    expect(parseStrictJson(text)).toEqual({ ok: false, issue: "too_large" });
    expect(parseStrictJson(`"${text}"`)).toEqual({ ok: false, issue: "too_large" });
    expect(parseStrictJson(`"${"漢".repeat(174_762)}"`).ok).toBe(true); // 524,288 bytes
  });

  it("a lone surrogate counts as 3 bytes (as UTF-8 encoding replaces it with U+FFFD)", () => {
    const lone = "\ud800";
    expect(Buffer.byteLength(lone, "utf8")).toBe(3);
    expect(parseStrictJson(jsonStringOfBytes(lone, LIMIT)).ok).toBe(true);
    expect(parseStrictJson(jsonStringOfBytes(lone, LIMIT + 1))).toEqual({ ok: false, issue: "too_large" });
    // and the \u escape form of lone surrogates is still parsed like JSON.parse
    expect(parseStrictJson('"\\ud800"')).toEqual({ ok: true, value: JSON.parse('"\\ud800"') });
  });

  it("over the limit, nothing downstream runs and no model output is used (AI_FAILED, model_json_too_large)", async () => {
    // A schema-valid answer padded with multibyte text inside a string: valid JSON, under 512 Ki UTF-16 units.
    const padded = GOOD_TEXT.replace('"Satay with peanut sauce"', `"Satay with peanut sauce ${"漢".repeat(175_000)}"`);
    expect(padded.length).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(LIMIT);
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, { text: padded, finishReason: "STOP" }) };
    const logs: LogEvent[] = [];
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), ON, {
      model,
      config: CFG,
      usage: testUsageGuard(),
      logger: (e) => logs.push(e),
      sleep: async () => {},
    });
    expect(res.status).not.toBe(200);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ failure: "model_json_too_large", attempts: 1 });
    expect(calls).toBe(1); // not retried
  });

  it("other limits and the duplicate check are unchanged", () => {
    expect(parseStrictJson('{"a":1,"aller\\u0067ens":2,"allergens":3}')).toEqual({ ok: false, issue: "duplicate_key" });
    expect(parseStrictJson("[".repeat(33) + "]".repeat(33))).toEqual({ ok: false, issue: "too_deep" });
    expect(parseStrictJson(`[${"0,".repeat(50_000)}0]`)).toEqual({ ok: false, issue: "too_large" });
  });

  it("normal split JSON is still accepted", async () => {
    const res = { candidates: [{ content: { parts: [{ text: GOOD_TEXT.slice(0, 50) }, { text: GOOD_TEXT.slice(50) }] }, finishReason: "STOP" }] };
    const model = createVertexMenuModel(CFG, (() => ({ models: { generateContent: async () => res } })) as never);
    expect((await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: allow })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("B: SDK safety metadata (promptFeedback) is strictly validated", () => {
  const cand = { content: { parts: [{ text: GOOD_TEXT }] }, finishReason: "STOP" };
  const withFeedback = (promptFeedback: unknown) => ({ candidates: [cand], promptFeedback });
  const viaClient = (res: unknown) => createVertexMenuModel(CFG, (() => ({ models: { generateContent: async () => res } })) as never);

  it.each([
    ["a string", "SAFETY"],
    ["an array", [{ blockReason: "SAFETY" }]],
    ["null", null],
    ["a number", 1],
    ["a boolean", true],
    ["blockReason as a number", { blockReason: 1 }],
    ["blockReason as an object", { blockReason: { reason: "SAFETY" } }],
    ["blockReason as null", { blockReason: null }],
    ["blockReasonMessage not a string", { blockReasonMessage: 5 }],
    ["safetyRatings not an array", { safetyRatings: "x" }],
    ["a safety rating that is not an object", { safetyRatings: ["x"] }],
    ["a safety rating with blocked: true", { safetyRatings: [{ category: "HARM_CATEGORY_HATE_SPEECH", blocked: true }] }],
    ["a safety rating with a non-boolean blocked", { safetyRatings: [{ blocked: "no" }] }],
    ["a safety rating with an unknown field", { safetyRatings: [{ category: "HARM_CATEGORY_HATE_SPEECH", SYNTHETIC_SECRET_TOKEN: 1 }] }],
    ["an unknown promptFeedback field", { SYNTHETIC_SECRET_TOKEN: "SYNTHETIC_SECRET_VALUE" }],
    ["an unknown safety-looking field", { blocked: true }],
  ])("promptFeedback that is %s → rejected, never answered with an analysis", async (_n, feedback) => {
    const res = withFeedback(feedback);
    const r = inspectModelResponse(res);
    expect(r.text).toBeUndefined();
    expect(r.outputIssue).toBe("malformed_response");
    const out = await analyzeWithGemini(viaClient(res), CFG, REQ, { requestId: "r", reserveAttempt: allow });
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1 });
  });

  it("audit repro: promptFeedback \"SAFETY\" with a valid candidate text is NOT HTTP 200", async () => {
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), ON, {
      model: viaClient(withFeedback("SAFETY")),
      config: CFG,
      usage: testUsageGuard(),
      logger: (e) => logs.push(e),
      sleep: async () => {},
    });
    expect(res.status).not.toBe(200);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ failure: "malformed_response" });
  });

  it("an unknown block reason string is a block (fail safe) and is logged only as \"unknown\"", async () => {
    const res = withFeedback({ blockReason: "SYNTHETIC_SECRET_TOKEN" });
    expect(inspectModelResponse(res)).toMatchObject({ text: GOOD_TEXT, blockReason: "unknown" });
    const out = await analyzeWithGemini(viaClient(res), CFG, REQ, { requestId: "r", reserveAttempt: allow });
    expect(out).toMatchObject({ ok: false, code: "AI_FAILED", failure: "blocked", finishReason: "unknown" });
    expect(JSON.stringify(sanitizeLogEvent({ event: "analyze_menu", requestId: "r", outcome: "error", failure: "blocked", finishReason: (out as { finishReason?: string }).finishReason }))).not.toMatch(/SYNTHETIC/);
  });

  it.each(["SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "MODEL_ARMOR", "JAILBREAK", "BLOCKED_REASON_UNSPECIFIED"])(
    "known block reason %s → blocked (AI_FAILED)",
    async (reason) => {
      const out = await analyzeWithGemini(viaClient({ promptFeedback: { blockReason: reason, blockReasonMessage: "SYNTHETIC message" } }), CFG, REQ, { requestId: "r", reserveAttempt: allow });
      expect(out).toMatchObject({ ok: false, code: "AI_FAILED", failure: "blocked", finishReason: reason });
    },
  );

  it.each([
    ["absent", undefined, false],
    ["an empty object", {}, true],
    ["safety ratings that did not block", { safetyRatings: [{ category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE", probabilityScore: 0.01, severity: "HARM_SEVERITY_NEGLIGIBLE", severityScore: 0, blocked: false }] }, true],
    ["an empty safetyRatings list", { safetyRatings: [] }, true],
  ])("a normal response with promptFeedback %s → parsed as before", async (_n, feedback, present) => {
    const res = present ? withFeedback(feedback) : { candidates: [cand] };
    expect(inspectModelResponse(res)).toEqual({ text: GOOD_TEXT, finishReason: "STOP", blockReason: undefined });
    expect((await analyzeWithGemini(viaClient(res), CFG, REQ, { requestId: "r", reserveAttempt: allow })).ok).toBe(true);
  });

  it("getters anywhere in promptFeedback are never invoked and reject the response", () => {
    let n = 0;
    const g = (v: unknown) => ({ enumerable: true, configurable: true, get: () => (n++, v) });
    const cases = [
      Object.defineProperty({}, "blockReasonMessage", g("x")),
      Object.defineProperty({}, "safetyRatings", g([])),
      { safetyRatings: Object.defineProperty([], 0, g({ blocked: true })) },
      { safetyRatings: [Object.defineProperty({}, "blocked", g(true))] },
      Object.defineProperty({}, "hidden", { ...g("SAFETY"), enumerable: false }),
    ];
    for (const fb of cases) {
      const r = inspectModelResponse(withFeedback(fb));
      expect(r.text).toBeUndefined();
      expect(r.outputIssue).toBe("malformed_response");
    }
    expect(n).toBe(0);
  });
});
