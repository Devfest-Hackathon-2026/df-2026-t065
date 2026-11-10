import { GoogleAuth } from "google-auth-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import { createVertexMenuModel, extractResponseText, type MenuModel, type ModelCallResult } from "@/server/gemini/vertexClient";
import { fakeJpeg, PERMIT } from "./helpers";

/*
 * PR5 limited re-audit (REVISE): SDK warning path (MAJOR) and synchronous throws
 * from the reservation hook (MINOR). SDK network/auth are test doubles; all model
 * outputs are SYNTHETIC.
 */

const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 5000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const GOOD = {
  status: "ok",
  imageIssues: [],
  items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }],
  menuNotices: [],
};
const GOOD_TEXT = JSON.stringify(GOOD);

// ---------------------------------------------------------------------------
describe("MAJOR: no SDK console output from the response, and strict text extraction", () => {
  let consoleOut: string[] = [];
  let apiBody: unknown;
  beforeEach(() => {
    consoleOut = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a) => void consoleOut.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
    }
    vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers({ authorization: "Bearer FAKE-ADC-TOKEN" }) as never);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(apiBody), { status: 200, headers: { "content-type": "application/json" } }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const call = () => createVertexMenuModel(CFG).generate(REQ, { signal: new AbortController().signal, timeoutMs: 1000 });
  const reply = (parts: unknown, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", ...extra }] });

  it("a part with an unknown key SYNTHETIC_SECRET_TOKEN: nothing reaches the console, and the response is rejected", async () => {
    apiBody = reply([{ text: GOOD_TEXT, SYNTHETIC_SECRET_TOKEN: "SYNTHETIC_SECRET_VALUE" }]);
    const r = await call();
    expect(consoleOut.join("\n")).not.toMatch(/SYNTHETIC_SECRET/);
    expect(consoleOut).toEqual([]);
    expect(r.text).toBeUndefined();
    expect(r.outputIssue).toBe("unexpected_part");
  });

  it("the same unknown part through the runner → AI_FAILED, no retry, no console output", async () => {
    apiBody = reply([{ text: GOOD_TEXT, SYNTHETIC_SECRET_TOKEN: 1 }]);
    const r = await analyzeWithGemini(createVertexMenuModel(CFG), CFG, REQ, { requestId: "r", reserveAttempt: async () => PERMIT }, { sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, code: "AI_FAILED", failure: "unexpected_part", attempts: 1 });
    expect(consoleOut).toEqual([]);
  });

  it("a normal single JSON text part is parsed as before", async () => {
    apiBody = reply([{ text: GOOD_TEXT }]);
    const r = await call();
    expect(r).toEqual({ text: GOOD_TEXT, finishReason: "STOP", blockReason: undefined });
    const out = await analyzeWithGemini(createVertexMenuModel(CFG), CFG, REQ, { requestId: "r", reserveAttempt: async () => PERMIT });
    expect(out.ok).toBe(true);
    expect(consoleOut).toEqual([]);
  });

  it("multiple candidates are rejected (candidateCount is 1) — no warning", async () => {
    apiBody = { candidates: [reply([{ text: GOOD_TEXT }]).candidates[0], reply([{ text: GOOD_TEXT }]).candidates[0]] };
    const r = await call();
    expect(r.outputIssue).toBe("malformed_response");
    expect(consoleOut).toEqual([]);
  });

  it("finishReason and blockReason keep their behaviour (and are read without the text getter)", async () => {
    apiBody = reply([{ text: GOOD_TEXT }], { finishReason: "MAX_TOKENS" });
    expect((await call()).finishReason).toBe("MAX_TOKENS");
    apiBody = { promptFeedback: { blockReason: "SAFETY" } };
    const blocked = await call();
    expect(blocked).toMatchObject({ blockReason: "SAFETY" });
    expect(blocked.text).toBeUndefined();
    expect(consoleOut).toEqual([]);
  });
});

describe("MAJOR: extractResponseText specification", () => {
  const c = (parts: unknown) => ({ candidates: [{ content: { parts } }] });
  it.each([
    ["no candidates", {}, "no_text"],
    ["empty candidates", { candidates: [] }, "no_text"],
    ["candidates not an array", { candidates: { 0: {} } }, "malformed_response"],
    ["two candidates", { candidates: [{ content: { parts: [{ text: "a" }] } }, { content: { parts: [{ text: "b" }] } }] }, "malformed_response"],
    ["missing content", { candidates: [{}] }, "no_text"],
    ["content not an object", { candidates: [{ content: "x" }] }, "malformed_response"],
    ["missing parts", { candidates: [{ content: {} }] }, "no_text"],
    ["empty parts", c([]), "no_text"],
    ["parts not an array", c({ text: "x" }), "malformed_response"],
    ["part is null", c([null]), "malformed_response"],
    ["part is a string", c(["x"]), "malformed_response"],
    ["text not a string", c([{ text: 5 }]), "malformed_response"],
    ["thought not a boolean", c([{ text: "x", thought: "yes" }]), "malformed_response"],
    ["inlineData part (non-text)", c([{ inlineData: { mimeType: "image/png", data: "AA==" } }]), "unexpected_part"],
    ["functionCall part (non-text)", c([{ functionCall: { name: "f", args: {} } }]), "unexpected_part"],
    ["text mixed with an unknown field", c([{ text: "{}" , SYNTHETIC_SECRET_TOKEN: "v" }]), "unexpected_part"],
    ["a valid text part next to a non-text part", c([{ text: "{}" }, { executableCode: { code: "x" } }]), "unexpected_part"],
    ["only thought parts", c([{ text: "thinking", thought: true }]), "no_text"],
    ["a part with neither text nor thought", c([{}]), "malformed_response"],
  ])("%s → %s (never a partial success)", (_n, res, issue) => {
    expect(extractResponseText(res)).toEqual({ ok: false, issue });
  });

  it.each([
    ["single text part", c([{ text: GOOD_TEXT }]), GOOD_TEXT],
    ["JSON split across text parts is joined in order", c([{ text: GOOD_TEXT.slice(0, 20) }, { text: GOOD_TEXT.slice(20) }]), GOOD_TEXT],
    ["thought parts are skipped, the answer is kept", c([{ text: "reasoning", thought: true }, { text: GOOD_TEXT }]), GOOD_TEXT],
    ["thoughtSignature is allowed", c([{ text: GOOD_TEXT, thoughtSignature: "c2ln" }]), GOOD_TEXT],
  ])("%s → text", (_n, res, text) => {
    expect(extractResponseText(res)).toEqual({ ok: true, text });
  });

  it("an empty text is returned as empty (the runner then reports empty_output)", () => {
    expect(extractResponseText(c([{ text: "" }]))).toEqual({ ok: true, text: "" });
  });

  it("never invokes a getter, even one that returns a plausible value", () => {
    let invoked = 0;
    const sneaky = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        invoked++;
        console.warn("SYNTHETIC_SECRET_TOKEN");
        return GOOD_TEXT;
      },
    });
    expect(extractResponseText(c([sneaky]))).toEqual({ ok: false, issue: "malformed_response" });
    const sneakyCandidates = Object.defineProperty({}, "candidates", {
      enumerable: true,
      get() {
        invoked++;
        return [{ content: { parts: [{ text: GOOD_TEXT }] } }];
      },
    });
    expect(extractResponseText(sneakyCandidates)).toEqual({ ok: false, issue: "malformed_response" });
    expect(invoked).toBe(0);
  });

  it("never reads through getters: a part whose property access throws is rejected, not propagated", () => {
    const trap = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        throw new Error("SYNTHETIC_SECRET_TOKEN");
      },
    });
    expect(extractResponseText(c([trap]))).toEqual({ ok: false, issue: "malformed_response" });
  });
});

// ---------------------------------------------------------------------------
describe("MINOR: synchronous throws from the reservation hook", () => {
  function counting(behaviour: (n: number) => Promise<ModelCallResult>) {
    let calls = 0;
    const model: MenuModel = { generate: async () => behaviour(++calls) };
    return { model, calls: () => calls };
  }
  const ok = async (): Promise<ModelCallResult> => ({ text: GOOD_TEXT, finishReason: "STOP" });
  const transient = async (): Promise<ModelCallResult> => {
    throw Object.assign(new Error("unavailable"), { status: 503 });
  };

  it("first reservation throws synchronously → AI_DISABLED, 0 model calls, reserved 0", async () => {
    const { model, calls } = counting(ok);
    const hook: ReserveAttempt = () => {
      throw new Error("SYNTHETIC_SECRET_TOKEN");
    };
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: hook });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reserved: 0 });
    expect(calls()).toBe(0);
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC_SECRET_TOKEN");
  });

  it("retry reservation throws synchronously → the first error is kept, no second call, reserved 1", async () => {
    const { model, calls } = counting((n) => (n === 1 ? transient() : ok()));
    let n = 0;
    const hook: ReserveAttempt = () => {
      if (++n === 2) throw new Error("SYNTHETIC_SECRET_TOKEN");
      return Promise.resolve(PERMIT);
    };
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: hook }, { sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, code: "AI_FAILED", failure: "upstream_transient", attempts: 1, reserved: 1, limitReason: "retry_usage_store_error" });
    expect(calls()).toBe(1);
  });

  it.each([1, 2])("a rejected promise on reservation #%i is handled the same way", async (which) => {
    const { model, calls } = counting((n) => (n === 1 ? transient() : ok()));
    let n = 0;
    const hook: ReserveAttempt = () => (++n === which ? Promise.reject(new Error("SYNTHETIC_SECRET_TOKEN")) : Promise.resolve(PERMIT));
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: hook }, { sleep: async () => {} });
    if (which === 1) {
      expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0, reserved: 0 });
      expect(calls()).toBe(0);
    } else {
      expect(r).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1, reserved: 1, limitReason: "retry_usage_store_error" });
      expect(calls()).toBe(1);
    }
  });

  it("model calls always equal confirmed reservations", async () => {
    const { model, calls } = counting((n) => (n === 1 ? transient() : ok()));
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: async () => PERMIT }, { sleep: async () => {} });
    expect(r).toMatchObject({ ok: true, attempts: 2, reserved: 2 });
    expect(calls()).toBe(2);
  });

  it("M2 regression: a reservation that succeeds after the deadline still starts no model call", async () => {
    let t = 1_000;
    const { model, calls } = counting(ok);
    const hook: ReserveAttempt = async () => {
      t += 5_001;
      return PERMIT;
    };
    const r = await analyzeWithGemini(model, { ...CFG, requestDeadlineMs: 5_000 }, REQ, { requestId: "r", reserveAttempt: hook }, { now: () => t });
    // Confirmed (late) reservation: counted as reserved, reported apart from a plain timeout (3rd audit).
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_reservation_late", reserved: 1, reservationsUnknown: 0 });
    expect(calls()).toBe(0);
  });

  it("fail-closed regression: an omitted hook still means no model call", async () => {
    const { model, calls } = counting(ok);
    // @ts-expect-error — reserveAttempt is required
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r" });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "reservation_missing" });
    expect(calls()).toBe(0);
  });
});
