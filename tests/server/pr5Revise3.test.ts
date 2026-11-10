import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import { createVertexMenuModel, extractResponseText, type MenuModel } from "@/server/gemini/vertexClient";
import { sanitizeLogEvent, type LogEvent } from "@/server/log";
import { UsageGuard } from "@/server/usage/guard";
import { InMemoryUsageStore, type UsageStore } from "@/server/usage/store";
import { blob, fakeJpeg, testUsageGuard, PERMIT } from "./helpers";

/*
 * PR5 safety audit (REVISE, 3rd round): duplicate JSON keys (MAJOR), thought
 * parts, nested getters, late reservation accounting, synchronous hook time
 * (MINOR). Model, store and SDK are test doubles. All model outputs are SYNTHETIC.
 */

const ON: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 5000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const MENTION = '{"code":"peanut","category":"menu_mentions","mentionKind":"contains_claim","excerpt":"peanut sauce"}';
const item = (allergensJson: string, extra = "") => `{"readText":"Satay with peanut sauce","readability":"clear","allergens":${allergensJson}${extra}}`;
const doc = (itemsJson: string, extra = "") => `{"status":"ok","imageIssues":[],"items":[${itemsJson}],"menuNotices":[]${extra}}`;
const GOOD_TEXT = doc(item(`[${MENTION}]`));

function textModel(text: string) {
  let calls = 0;
  const model: MenuModel = { generate: async () => (calls++, { text, finishReason: "STOP" }) };
  return { model, calls: () => calls };
}
const allow: ReserveAttempt = async () => PERMIT;
const run = (text: string) => analyzeWithGemini(textModel(text).model, CFG, REQ, { requestId: "r", reserveAttempt: allow }, { sleep: async () => {} });

function request(): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}

// ---------------------------------------------------------------------------
describe("MAJOR: duplicate JSON keys never silently drop allergen information", () => {
  it("audit repro: a menu_mentions entry followed by `allergens: []` is NOT answered with HTTP 200", async () => {
    const text = doc(item(`[${MENTION}]`, ',"allergens":[]'));
    // JSON.parse would keep only the last key: the menu mention disappears.
    expect((JSON.parse(text) as { items: { allergens: unknown[] }[] }).items[0]!.allergens).toEqual([]);
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, { model: textModel(text).model, config: CFG, usage: testUsageGuard(), logger: (e) => logs.push(e), sleep: async () => {} });
    expect(res.status).not.toBe(200);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ failure: "model_duplicate_key", attempts: 1 });
  });

  it.each([
    ["the same value twice", doc(item(`[${MENTION}]`, `,"allergens":[${MENTION}]`))],
    ["a top-level duplicate", doc(item(`[${MENTION}]`), ',"status":"ok"')],
    ["a duplicate inside a nested allergen object", doc(item(`[{"code":"peanut","category":"menu_mentions","mentionKind":"contains_claim","excerpt":"peanut sauce","category":"unconfirmed"}]`))],
    ["the same key written with a Unicode escape", doc(item(`[${MENTION}]`, ',"aller\\u0067ens":[]'))],
    ["an escaped key first, the plain key second", doc(`{"readText":"Satay with peanut sauce","readability":"clear","\\u0061llergens":[${MENTION}],"allergens":[]}`)],
    ["a surrogate-pair escape equal to the raw character", doc(item(`[${MENTION}]`), ',"\u{1F95C}":1,"\\ud83e\\udd5c":2')],
  ])("%s → AI_FAILED (model_duplicate_key)", async (_n, text) => {
    expect(await run(text)).toMatchObject({ ok: false, code: "AI_FAILED", failure: "model_duplicate_key", attempts: 1 });
  });

  it("the same key name in DIFFERENT objects is fine", async () => {
    const two = doc(`${item(`[${MENTION}]`)},{"readText":"Peanut noodles","readability":"clear","allergens":[{"code":"peanut","category":"menu_mentions","mentionKind":"contains_claim","excerpt":"Peanut"}]}`);
    const r = await run(two);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.items).toHaveLength(2);
  });

  it("key-like text inside a string value is fine", async () => {
    const text = doc(`{"readText":"Satay \\"allergens\\": [] with peanut sauce","readability":"clear","allergens":[${MENTION}]}`);
    const r = await run(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.items[0]!.readText.text).toBe('Satay "allergens": [] with peanut sauce');
  });

  it("correctly split text parts are joined and accepted", async () => {
    const res = { candidates: [{ content: { parts: [{ text: GOOD_TEXT.slice(0, 37) }, { text: GOOD_TEXT.slice(37, 90) }, { text: GOOD_TEXT.slice(90) }] }, finishReason: "STOP" }] };
    const model = createVertexMenuModel(CFG, (() => ({ models: { generateContent: async () => res } })) as never);
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: allow });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["invalid JSON", '{"status":"ok",'],
    ["two JSON documents", `${GOOD_TEXT}${GOOD_TEXT}`],
    ["two documents separated by whitespace", `${GOOD_TEXT}\n${GOOD_TEXT}`],
    ["trailing garbage", `${GOOD_TEXT} x`],
  ])("%s → AI_FAILED (model_invalid_json)", async (_n, text) => {
    expect(await run(text)).toMatchObject({ ok: false, code: "AI_FAILED", failure: "model_invalid_json" });
  });

  it("existing model-output checks still run after parsing (schema violation → model_schema)", async () => {
    expect(await run(doc(item(`[${MENTION}]`), ',"safe":true'))).toMatchObject({ ok: false, failure: "model_schema" });
    expect(await run(GOOD_TEXT)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
describe("MINOR: thought parts are validated as a whole", () => {
  const c = (parts: unknown) => ({ candidates: [{ content: { parts } }] });
  it.each([
    ["thought part with a non-string text", c([{ thought: true, text: 5 }, { text: GOOD_TEXT }]), "malformed_response"],
    ["thought part with an object text", c([{ thought: true, text: { a: 1 } }, { text: GOOD_TEXT }]), "malformed_response"],
    ["thought part with an unknown key", c([{ thought: true, text: "x", inlineData: {} }, { text: GOOD_TEXT }]), "unexpected_part"],
    ["thought part with a bad thoughtSignature", c([{ thought: true, text: "x", thoughtSignature: 1 }, { text: GOOD_TEXT }]), "malformed_response"],
  ])("%s → whole response rejected (%s)", (_n, res, issue) => {
    expect(extractResponseText(res)).toEqual({ ok: false, issue });
  });
  it("valid thought + text combinations keep working", () => {
    expect(extractResponseText(c([{ thought: true, text: "reasoning" }, { text: GOOD_TEXT }]))).toEqual({ ok: true, text: GOOD_TEXT });
    expect(extractResponseText(c([{ thought: true }, { text: GOOD_TEXT, thoughtSignature: "c2ln" }]))).toEqual({ ok: true, text: GOOD_TEXT });
    expect(extractResponseText(c([{ thought: false, text: GOOD_TEXT }]))).toEqual({ ok: true, text: GOOD_TEXT });
  });
});

// ---------------------------------------------------------------------------
describe("MINOR: getters are never invoked at any level", () => {
  function getter<T>(value: T, counter: { n: number }) {
    return {
      enumerable: true,
      configurable: true,
      get() {
        counter.n++;
        return value;
      },
    };
  }
  const part = () => ({ text: GOOD_TEXT });

  it("a candidates[0] element reachable only through a getter → malformed, 0 invocations", () => {
    const n = { n: 0 };
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, getter({ content: { parts: [part()] } }, n));
    expect(extractResponseText({ candidates: arr })).toEqual({ ok: false, issue: "malformed_response" });
    expect(n.n).toBe(0);
  });

  it("a content property that is a getter → malformed, 0 invocations", () => {
    const n = { n: 0 };
    const cand = Object.defineProperty({}, "content", getter({ parts: [part()] }, n));
    expect(extractResponseText({ candidates: [cand] })).toEqual({ ok: false, issue: "malformed_response" });
    expect(n.n).toBe(0);
  });

  it("a parts[i] element reachable only through a getter → malformed, 0 invocations", () => {
    const n = { n: 0 };
    const parts: unknown[] = [part()];
    Object.defineProperty(parts, 1, getter({ text: "" }, n));
    expect(extractResponseText({ candidates: [{ content: { parts } }] })).toEqual({ ok: false, issue: "malformed_response" });
    expect(n.n).toBe(0);
  });

  it("a non-enumerable accessor on a part → rejected, 0 invocations", () => {
    const n = { n: 0 };
    const p = Object.defineProperty({ text: GOOD_TEXT }, "inlineData", { ...getter({}, n), enumerable: false });
    expect(extractResponseText({ candidates: [{ content: { parts: [p] } }] }).ok).toBe(false);
    expect(n.n).toBe(0);
  });

  const viaClient = (res: unknown) =>
    createVertexMenuModel(CFG, (() => ({ models: { generateContent: async () => res } })) as never).generate(REQ, { signal: new AbortController().signal, timeoutMs: 1000 });

  it("a finishReason getter cannot bypass the finish check → AI_FAILED, 0 invocations", async () => {
    const n = { n: 0 };
    const cand = Object.defineProperty({ content: { parts: [part()] } }, "finishReason", getter("SAFETY", n));
    const res = { candidates: [cand] };
    const r = await viaClient(res);
    expect(r.text).toBeUndefined();
    expect(r.outputIssue).toBe("malformed_response");
    const model = createVertexMenuModel(CFG, (() => ({ models: { generateContent: async () => res } })) as never);
    expect(await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: allow })).toMatchObject({ ok: false, code: "AI_FAILED" });
    expect(n.n).toBe(0);
  });

  it("a promptFeedback / blockReason getter cannot bypass the block check → AI_FAILED, 0 invocations", async () => {
    const n = { n: 0 };
    const viaFeedback = Object.defineProperty({ candidates: [{ content: { parts: [part()] }, finishReason: "STOP" }] }, "promptFeedback", getter({ blockReason: "SAFETY" }, n));
    const viaReason = { candidates: [{ content: { parts: [part()] }, finishReason: "STOP" }], promptFeedback: Object.defineProperty({}, "blockReason", getter("SAFETY", n)) };
    for (const res of [viaFeedback, viaReason]) {
      const r = await viaClient(res);
      expect(r.text).toBeUndefined();
      expect(r.outputIssue).toBe("malformed_response");
    }
    expect(n.n).toBe(0);
  });

  it("normal data properties keep working", async () => {
    expect(await viaClient({ candidates: [{ content: { parts: [part()] }, finishReason: "STOP" }], promptFeedback: {} })).toEqual({ text: GOOD_TEXT, finishReason: "STOP", blockReason: undefined });
    expect(await viaClient({ promptFeedback: { blockReason: "SAFETY" } })).toMatchObject({ blockReason: "SAFETY", text: undefined });
  });
});

// ---------------------------------------------------------------------------
describe("MINOR: late reservations are accounted as confirmed, unknown ones separately", () => {
  const okModel = () => {
    let calls = 0;
    const model: MenuModel = { generate: async () => (calls++, { text: GOOD_TEXT, finishReason: "STOP" }) };
    return { model, calls: () => calls };
  };

  it("runner: a reservation confirmed AFTER the deadline counts as reserved (confirmed), no model call", async () => {
    let t = 0;
    const { model, calls } = okModel();
    const hook: ReserveAttempt = async () => {
      t += 5_001;
      return PERMIT;
    };
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: 5_000, reserveAttempt: hook }, { now: () => t });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_reservation_late", attempts: 0, reserved: 1, reservationsUnknown: 0 });
    expect(calls()).toBe(0);
  });

  it("runner: a hook answering allowed_late never starts a model call, even if the runner's clock is still in time", async () => {
    const { model, calls } = okModel();
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", reserveAttempt: async () => ({ ...PERMIT, decision: "allowed_late" as const }) });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_reservation_late", attempts: 0, reserved: 1, reservationsUnknown: 0 });
    expect(calls()).toBe(0);
  });

  it("guard: a store that confirms after the deadline reports allowed_late (not a plain timeout)", async () => {
    let t = 0;
    const base = new InMemoryUsageStore(() => t);
    const slow: UsageStore = { kind: "slow", consume: async (...a) => ((t += 5_001), base.consume(...a)) };
    const g = new UsageGuard(slow, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, () => t);
    expect((await g.reserveInference(5_000)).decision).toBe("allowed_late");
  });

  it("runner: an unanswered reservation is counted as UNKNOWN (may still be consumed), not as confirmed", async () => {
    const { model, calls } = okModel();
    const r = await analyzeWithGemini(model, { ...CFG, requestDeadlineMs: 1_200 }, REQ, { requestId: "r", reserveAttempt: () => new Promise(() => {}) });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_timeout", attempts: 0, reserved: 0, reservationsUnknown: 1 });
    expect(calls()).toBe(0);
  });

  it("retry: first confirmed + retry confirmed late → reserved 2, 1 model call, first error kept", async () => {
    let t = 0;
    let n = 0;
    let calls = 0;
    const model: MenuModel = {
      generate: async () => {
        calls++;
        throw Object.assign(new Error("unavailable"), { status: 503 });
      },
    };
    const hook: ReserveAttempt = async () => {
      if (++n === 2) t += 5_001;
      return PERMIT;
    };
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: 5_000, reserveAttempt: hook }, { now: () => t, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, code: "AI_FAILED", failure: "upstream_transient", attempts: 1, reserved: 2, reservationsUnknown: 0, limitReason: "retry_usage_reservation_late" });
    expect(calls).toBe(1);
  });

  it("handler log: confirmed and unknown reservations are both logged (allow-listed numbers)", async () => {
    let t = 0;
    const base = new InMemoryUsageStore(() => t);
    const slow: UsageStore = { kind: "slow", consume: async (key, ...a) => (key.startsWith("daily:") && (t += 5_001), base.consume(key, ...a)) };
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), ON, {
      model: okModel().model,
      config: CFG,
      usage: new UsageGuard(slow, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, () => t),
      now: () => t,
      logger: (e) => logs.push(e),
    });
    expect(res.status).not.toBe(200);
    expect(sanitizeLogEvent(logs[0]!)).toMatchObject({ failure: "usage_reservation_late", reserved: 1, reservationsUnknown: 0, attempts: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("MINOR: the synchronous part of the hook spends the same deadline", () => {
  it("audit case: 5 s deadline, a hook that blocks 4 s synchronously then never answers → ends at ~5 s, not 9 s", async () => {
    let skew = 0; // simulated synchronous blocking time
    const now = () => Date.now() + skew;
    const start = now();
    const hook: ReserveAttempt = () => {
      skew += 4_000;
      return new Promise(() => {});
    };
    const realStart = Date.now();
    const r = await analyzeWithGemini(textModel(GOOD_TEXT).model, CFG, REQ, { requestId: "r", deadlineAt: start + 5_000, reserveAttempt: hook }, { now });
    expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_timeout", attempts: 0 });
    expect(now() - start).toBeLessThan(5_400);
    expect(Date.now() - realStart).toBeLessThan(2_000);
  }, 12_000);

  it("a hook whose synchronous part already passes the deadline → immediate timeout", async () => {
    let skew = 0;
    const now = () => Date.now() + skew;
    const start = now();
    const hook: ReserveAttempt = () => {
      skew += 6_000;
      return new Promise(() => {});
    };
    const realStart = Date.now();
    const r = await analyzeWithGemini(textModel(GOOD_TEXT).model, CFG, REQ, { requestId: "r", deadlineAt: start + 5_000, reserveAttempt: hook }, { now });
    expect(r).toMatchObject({ ok: false, failure: "usage_store_timeout", attempts: 0 });
    expect(Date.now() - realStart).toBeLessThan(300);
  }, 12_000);

  it("retry: the retry hook's synchronous part spends the SAME deadline", async () => {
    let skew = 0;
    const now = () => Date.now() + skew;
    const start = now();
    let n = 0;
    const hook: ReserveAttempt = () => {
      if (++n === 1) return Promise.resolve(PERMIT);
      skew += 3_000;
      return new Promise(() => {});
    };
    const model: MenuModel = {
      generate: async () => {
        throw Object.assign(new Error("unavailable"), { status: 503 });
      },
    };
    const realStart = Date.now();
    const r = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: start + 5_000, reserveAttempt: hook }, { now, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 1, limitReason: "retry_usage_store_timeout" });
    expect(now() - start).toBeLessThan(5_400);
    expect(Date.now() - realStart).toBeLessThan(2_600);
  }, 12_000);

  it("guard: a store whose synchronous part blocks 4 s of a 5 s deadline waits only the rest", async () => {
    let skew = 0;
    const now = () => Date.now() + skew;
    const hang: UsageStore = {
      kind: "hang",
      consume: () => {
        skew += 4_000;
        return new Promise(() => {});
      },
    };
    const g = new UsageGuard(hang, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, now);
    const realStart = Date.now();
    expect((await g.reserveInference(now() + 5_000)).decision).toBe("store_timeout");
    expect(Date.now() - realStart).toBeLessThan(2_000);
  }, 12_000);

  it("fail-closed regressions: sync throw / reject / invalid value still mean no model call", async () => {
    for (const hook of [
      (() => {
        throw new Error("SYNTHETIC_SECRET_TOKEN");
      }) as ReserveAttempt,
      (() => Promise.reject(new Error("x"))) as ReserveAttempt,
      (async () => "yes") as unknown as ReserveAttempt,
    ]) {
      const m = textModel(GOOD_TEXT);
      const r = await analyzeWithGemini(m.model, CFG, REQ, { requestId: "r", reserveAttempt: hook });
      expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", attempts: 0 });
      expect(m.calls()).toBe(0);
    }
  });
});
