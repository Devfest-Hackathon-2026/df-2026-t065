import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema, AnalyzeMenuResponseSchema, checkResponseInvariants, type AnalyzeMenuResponse } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { hasPublishedAiRationale } from "@/server/gemini/analyzeWithGemini";
import type { MenuModel } from "@/server/gemini/vertexClient";
import type { LogEvent } from "@/server/log";
import { blob, fakeJpeg, testUsageGuard } from "./helpers";

/*
 * EV-052 (production-safety BLOCKER): an AI rationale for an ai_inferred
 * assessment must never reach the public API response — whatever it says.
 *
 * These tests do NOT pass because a dangerous word is absent. They check that the
 * rationale is not published at all (always null), for assertions, paraphrases,
 * negations, warnings, quotes and harmless reasons alike, and that everything
 * else in the response is kept.
 *
 * Real handleAnalyzeMenu path (production env) with a FAKE model. No network,
 * no credentials, no real Gemini. All menu text below is SYNTHETIC TEST DATA.
 */

const PROD: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "test-project", location: "test-location", model: "test-model", attemptTimeoutMs: 1_000, requestDeadlineMs: 10_000, maxOutputTokens: 4096 };
const SELECTED = ["peanut", "wheat", "egg", "milk", "soy", "sesame", "shrimp"] as const;

const READ_TEXT = "Egg-free Fruit Tart, wheat crust, soy glaze?, may contain milk";
const NOTICE_TEXT = "Shared fryer with peanut dishes";

/** Model output: peanut is ai_inferred with the rationale under test; all other categories/kinds are present. */
function modelOutput(rationale: unknown, omit = false) {
  const inferred: Record<string, unknown> = { code: "peanut", category: "ai_inferred" };
  if (!omit) inferred.rationale = rationale;
  return {
    status: "ok",
    imageIssues: [],
    items: [
      {
        readText: READ_TEXT,
        readTextLang: "en",
        translation: "卵不使用のフルーツタルト",
        readability: "clear",
        allergens: [
          inferred,
          { code: "wheat", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "wheat crust" },
          { code: "egg", category: "menu_mentions", mentionKind: "absence_claim", excerpt: "Egg-free" },
          { code: "milk", category: "menu_mentions", mentionKind: "possible_presence", excerpt: "may contain milk" },
          { code: "soy", category: "menu_mentions", mentionKind: "ambiguous", excerpt: "soy glaze?" },
          { code: "sesame", category: "unconfirmed", unconfirmedReason: "not_mentioned" },
          // shrimp is omitted on purpose → the server fills it in as unconfirmed / not_assessed
        ],
      },
    ],
    menuNotices: [{ readText: NOTICE_TEXT, readTextLang: "en", translation: "落花生料理と共用のフライヤー", mentions: [{ code: "peanut", kind: "possible_presence" }] }],
  };
}

function request(): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  for (const a of SELECTED) f.append("allergens", a);
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "menu.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}

async function analyze(output: unknown) {
  const model: MenuModel = { generate: async () => ({ text: JSON.stringify(output), finishReason: "STOP" }) };
  const logs: LogEvent[] = [];
  const res = await handleAnalyzeMenu(request(), PROD, { model, config: CFG, usage: testUsageGuard(), logger: (e) => logs.push(e) });
  const raw = await res.text();
  return { status: res.status, raw, logs };
}

/** Everything except the peanut rationale, exactly as it must be published. */
function expectEverythingElseKept(body: AnalyzeMenuResponse) {
  expect(body.dataOrigin).toBe("ai_analysis");
  expect(body.status).toBe("ok");
  expect(checkResponseInvariants(body, SELECTED)).toEqual([]);
  const item = body.items[0]!;
  expect(item.readText).toEqual({ text: READ_TEXT, lang: "en", readBy: "ai" });
  expect(item.aiTranslation).toEqual({ text: "卵不使用のフルーツタルト", lang: "ja", verified: false });
  // every selected allergen is present exactly once; every entry requires staff confirmation
  expect(item.allergens.map((a) => a.code).sort()).toEqual([...SELECTED].sort());
  expect(item.allergens.every((a) => a.confirmationRequired === true)).toBe(true);
  const by = Object.fromEntries(item.allergens.map((a) => [a.code, a]));
  expect(by.peanut).toEqual({ code: "peanut", category: "ai_inferred", rationale: null, confirmationRequired: true });
  expect(by.wheat).toEqual({ code: "wheat", category: "menu_mentions", mention: { kind: "contains_claim", excerpt: "wheat crust" }, confirmationRequired: true });
  expect(by.egg).toEqual({ code: "egg", category: "menu_mentions", mention: { kind: "absence_claim", excerpt: "Egg-free" }, confirmationRequired: true });
  expect(by.milk).toEqual({ code: "milk", category: "menu_mentions", mention: { kind: "possible_presence", excerpt: "may contain milk" }, confirmationRequired: true });
  expect(by.soy).toEqual({ code: "soy", category: "menu_mentions", mention: { kind: "ambiguous", excerpt: "soy glaze?" }, confirmationRequired: true });
  expect(by.sesame).toEqual({ code: "sesame", category: "unconfirmed", reason: "not_mentioned", confirmationRequired: true });
  expect(by.shrimp).toEqual({ code: "shrimp", category: "unconfirmed", reason: "not_assessed", confirmationRequired: true });
  // cross-contact notice kept
  expect(body.menuNotices).toEqual([
    {
      id: "notice-1",
      readText: { text: NOTICE_TEXT, lang: "en", readBy: "ai" },
      aiTranslation: { text: "落花生料理と共用のフライヤー", lang: "ja", verified: false },
      mentions: [{ code: "peanut", kind: "possible_presence" }],
    },
  ]);
}

const CASES: [string, string][] = [
  ["1 英語の明確な安全断定", "It is safe to eat."],
  ["2 日本語の明確な安全断定", "落花生アレルギーでも安全です。"],
  ["3 言い換えた安全断定", "You can enjoy this without worry."],
  ["4 別の言い換え", "No problem for people with peanut allergies."],
  ["5 否定文", "It cannot be confirmed safe."],
  ["6 注意喚起", "Not guaranteed to be safe."],
  ["7 日本語の注意喚起", "安全とは限りません。"],
  ["8 引用文", 'The menu says "safe".'],
  ["9 正常な食材推測理由", "This dish commonly uses sesame oil."],
];

describe("EV-052: the AI rationale is never published (real handleAnalyzeMenu path, fake model)", () => {
  it.each(CASES)("%s → 200, ai_inferred kept, rationale null, the text appears nowhere in the response or logs", async (_name, rationale) => {
    const { status, raw, logs } = await analyze(modelOutput(rationale));
    expect(status).toBe(200);
    const body = AnalyzeMenuResponseSchema.parse(JSON.parse(raw));
    expectEverythingElseKept(body);
    expect(raw.includes(rationale)).toBe(false);
    expect(raw.includes(JSON.stringify(rationale).slice(1, -1))).toBe(false); // also not in escaped form
    expect(raw).not.toContain('"rationale":"');
    const logText = JSON.stringify(logs);
    expect(logText.includes(rationale)).toBe(false);
    expect(logText.includes(READ_TEXT)).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ outcome: "ok" });
  });

  it.each([
    ["10a rationale null", null, false],
    ["10b rationale omitted", undefined, true],
    ["10c rationale empty", "", false],
    ["10d rationale whitespace / invisible only", " ​ ", false],
  ] as const)("%s → 200 with rationale null and everything else kept", async (_n, rationale, omit) => {
    const { status, raw } = await analyze(modelOutput(rationale, omit));
    expect(status).toBe(200);
    expectEverythingElseKept(AnalyzeMenuResponseSchema.parse(JSON.parse(raw)));
  });

  it("every ai_inferred rationale in a multi-item response is null (not just the first one)", async () => {
    const o = modelOutput("It is safe to eat.");
    o.items.push({ ...o.items[0]!, readText: "Peanut-free cookie, wheat crust, soy glaze?, may contain milk, Egg-free" });
    (o.items[1]!.allergens as Record<string, unknown>[])[0] = { code: "peanut", category: "ai_inferred", rationale: "完全に安全に食べられます。" };
    const { status, raw } = await analyze(o);
    expect(status).toBe(200);
    const body = AnalyzeMenuResponseSchema.parse(JSON.parse(raw));
    const inferred = body.items.flatMap((i) => i.allergens).filter((a) => a.category === "ai_inferred");
    expect(inferred).toHaveLength(2);
    expect(inferred.every((a) => a.category === "ai_inferred" && a.rationale === null)).toBe(true);
    expect(raw).not.toContain("完全に安全");
  });
});

describe("EV-052: nullable-field boundaries — strictness is NOT relaxed by dropping the rationale", () => {
  it("a 200-character rationale (the contract maximum) is accepted and still not published", async () => {
    const r = "a".repeat(199) + ".";
    const { status, raw } = await analyze(modelOutput(r));
    expect(status).toBe(200);
    expect(raw.includes(r)).toBe(false);
    expectEverythingElseKept(AnalyzeMenuResponseSchema.parse(JSON.parse(raw)));
  });

  it("a 201-character rationale still fails the whole response (as before the fix) → AI_FAILED", async () => {
    const { status, raw, logs } = await analyze(modelOutput("a".repeat(201)));
    expect(status).toBe(502);
    expect(AnalyzeMenuErrorSchema.parse(JSON.parse(raw)).error.code).toBe("AI_FAILED");
    expect(logs[0]).toMatchObject({ failure: "model_inconsistent_assessment" });
  });

  it.each([
    ["number", 1],
    ["object", { text: "safe" }],
    ["array", ["safe"]],
  ])("a non-string rationale (%s) is a model schema violation → AI_FAILED", async (_n, rationale) => {
    const { raw, logs } = await analyze(modelOutput(rationale));
    expect(AnalyzeMenuErrorSchema.parse(JSON.parse(raw)).error.code).toBe("AI_FAILED");
    expect(logs[0]).toMatchObject({ failure: "model_schema" });
  });

  it.each([
    ["menu_mentions", { code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "wheat crust", rationale: "It is safe." }],
    ["unconfirmed", { code: "peanut", category: "unconfirmed", unconfirmedReason: "not_mentioned", rationale: "It is safe." }],
  ])("a rationale on %s is still rejected (unchanged) → AI_FAILED", async (_n, a) => {
    const o = modelOutput(null);
    (o.items[0]!.allergens as unknown[])[0] = a;
    const { raw } = await analyze(o);
    expect(AnalyzeMenuErrorSchema.parse(JSON.parse(raw)).error.code).toBe("AI_FAILED");
  });

  it("an extra field next to the rationale is still rejected (strict model schema unchanged)", async () => {
    const o = modelOutput("ok");
    (o.items[0]!.allergens as Record<string, unknown>[])[0]!.safe = true;
    const { raw, logs } = await analyze(o);
    expect(AnalyzeMenuErrorSchema.parse(JSON.parse(raw)).error.code).toBe("AI_FAILED");
    expect(logs[0]).toMatchObject({ failure: "model_schema" });
  });
});

describe("EV-052 safety net: hasPublishedAiRationale", () => {
  const base = (rationale: string | null): AnalyzeMenuResponse =>
    AnalyzeMenuResponseSchema.parse({
      requestId: "r",
      status: "ok",
      dataOrigin: "ai_analysis",
      imageIssues: [],
      items: [
        {
          id: "item-1",
          readText: { text: "Fruit Tart", lang: "en", readBy: "ai" },
          aiTranslation: null,
          readability: "clear",
          allergens: [{ code: "peanut", category: "ai_inferred", rationale, confirmationRequired: true }],
        },
      ],
      menuNotices: [],
    });

  it("is true when any ai_inferred rationale is non-null (NEGATIVE CONTROL)", () => {
    expect(hasPublishedAiRationale(base("It is safe to eat."))).toBe(true);
  });

  it("is false when every rationale is null", () => {
    expect(hasPublishedAiRationale(base(null))).toBe(false);
  });
});
