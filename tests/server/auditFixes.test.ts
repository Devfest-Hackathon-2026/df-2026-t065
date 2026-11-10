import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GoogleAuth } from "google-auth-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzeMenuErrorSchema, AnalyzeMenuResponseSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import { readGeminiConfig, type GeminiConfig } from "@/server/config";
import { analyzeWithGemini } from "@/server/gemini/analyzeWithGemini";
import { EndpointNotAllowedError, createGuardedFetch, createVertexMenuModel, type MenuModel } from "@/server/gemini/vertexClient";
import { blob, fakeJpeg, testUsageGuard, PERMIT } from "./helpers";

/*
 * Regression tests for the PR2 audit findings (MJ-3, mn-1).
 * All model outputs are SYNTHETIC. No network: fetch and ADC are test doubles.
 */

const PROD: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "proj-x", location: "asia-northeast1", model: "model-y", attemptTimeoutMs: 1000, requestDeadlineMs: 5000, maxOutputTokens: 4096 };
const BASE_ENV = { GOOGLE_CLOUD_PROJECT: "proj-x", GOOGLE_CLOUD_LOCATION: "asia-northeast1", GEMINI_MODEL: "model-y" };

function request(allergens = ["peanut", "soy"]): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  for (const a of allergens) f.append("allergens", a);
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}
const modelOf = (o: unknown): MenuModel => ({ generate: async () => ({ text: JSON.stringify(o), finishReason: "STOP" }) });
const item = (extra: Record<string, unknown> = {}) => ({
  readText: "Satay with peanut sauce",
  readability: "clear",
  allergens: [
    { code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" },
    { code: "soy", category: "ai_inferred", rationale: "Marinades often contain soy sauce." },
  ],
  ...extra,
});
const out = (items: unknown[]) => ({ status: "ok", imageIssues: [], items, menuNotices: [] });
const run = (o: unknown) => handleAnalyzeMenu(request(), PROD, { model: modelOf(o), config: CFG, usage: testUsageGuard(), logger: () => {} });

describe("MJ-3: empty optional strings become null instead of failing the whole response", () => {
  it.each([
    ["empty string", ""],
    ["spaces", "   "],
    ["full-width space + newline", "　\n"],
    ["invisible only (U+2063)", "⁣"],
    ["null", null],
  ])("translation = %s → 200 with aiTranslation null", async (_n, translation) => {
    const res = await run(out([item({ translation })]));
    expect(res.status).toBe(200);
    expect(AnalyzeMenuResponseSchema.parse(await res.json()).items[0]!.aiTranslation).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["spaces", " \t "],
    ["invisible only", "​‎"],
    ["null", null],
  ])("ai_inferred rationale = %s → 200 with rationale null", async (_n, rationale) => {
    const o = out([item({ allergens: [{ code: "soy", category: "ai_inferred", rationale }] })]);
    const res = await handleAnalyzeMenu(request(["soy"]), PROD, { model: modelOf(o), config: CFG, usage: testUsageGuard(), logger: () => {} });
    expect(res.status).toBe(200);
    expect(AnalyzeMenuResponseSchema.parse(await res.json()).items[0]!.allergens[0]).toEqual({
      code: "soy",
      category: "ai_inferred",
      rationale: null,
      confirmationRequired: true,
    });
  });

  it("empty optional strings in a menu notice translation become null", async () => {
    const o = { ...out([item()]), menuNotices: [{ readText: "Shared fryer", translation: " ", mentions: [{ code: "peanut", kind: "possible_presence" }] }] };
    const res = await run(o);
    expect(res.status).toBe(200);
    expect(AnalyzeMenuResponseSchema.parse(await res.json()).menuNotices[0]!.aiTranslation).toBeNull();
  });

  it("a normal translation is kept unchanged; the AI rationale is never published (EV-052)", async () => {
    const res = await run(out([item({ translation: "ピーナッツソースのサテ" })]));
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.items[0]!.aiTranslation).toEqual({ text: "ピーナッツソースのサテ", lang: "ja", verified: false });
    expect(body.items[0]!.allergens[1]).toEqual({ code: "soy", category: "ai_inferred", rationale: null, confirmationRequired: true });
  });

  // Required fields are NOT relaxed.
  it.each([
    ["empty readText", out([item({ readText: "" })])],
    ["invisible-only readText", out([item({ readText: "⁣‎" })])],
    ["empty excerpt on menu_mentions", out([item({ allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "" }] })])],
    ["null excerpt on menu_mentions", out([item({ allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: null }] })])],
    ["invisible-only excerpt", out([item({ allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "⁣" }] })])],
    ["null mentionKind on menu_mentions", out([item({ allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: null, excerpt: "peanut sauce" }] })])],
    ["null unconfirmedReason", out([item({ allergens: [{ code: "peanut", category: "unconfirmed", unconfirmedReason: null }] })])],
    ["unknown enum value", out([item({ allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "verified_absent", excerpt: "peanut sauce" }] })])],
    ["excerpt on ai_inferred", out([item({ allergens: [{ code: "soy", category: "ai_inferred", excerpt: "peanut sauce" }] })])],
    [
      "duplicate conflicting assessments",
      out([item({ allergens: [
        { code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" },
        { code: "peanut", category: "unconfirmed", unconfirmedReason: "not_mentioned" },
      ] })]),
    ],
    ["unknown field", out([item({ safe: true })])],
  ])("still rejects (AI_FAILED): %s", async (_n, o) => {
    const res = await run(o);
    expect(res.status).toBe(502);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
  });
});

describe("mn-1: SDK endpoint overrides can never redirect the ADC token", () => {
  it.each([
    ["GOOGLE_VERTEX_BASE_URL", "https://attacker.example/"],
    ["GOOGLE_GEMINI_BASE_URL", "https://attacker.example/"],
    ["google_vertex_base_url", "https://attacker.example/"],
    ["Google_Vertex_Base_Url", "x"],
    ["GOOGLE_VERTEX_BASE_URL", "not a url"],
  ])("config refuses to start when %s is set (→ AI_DISABLED)", (name, value) => {
    const r = readGeminiConfig({ ...BASE_ENV, [name]: value });
    expect(r.ok).toBe(false);
  });

  it.each([["empty", ""], ["whitespace", "   "]])("an %s override is treated as unset, exactly like the SDK does", (_n, value) => {
    expect(readGeminiConfig({ ...BASE_ENV, GOOGLE_VERTEX_BASE_URL: value }).ok).toBe(true);
  });

  it("the handler returns AI_DISABLED and never builds a client when an override is set", async () => {
    const auth = vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers() as never);
    const net = vi.fn();
    vi.stubGlobal("fetch", net);
    const res = await handleAnalyzeMenu(request(), { ...PROD, ...BASE_ENV, GOOGLE_VERTEX_BASE_URL: "https://attacker.example/" } as AnalyzeEnv, { logger: () => {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(expect.objectContaining({ error: { code: "AI_DISABLED", retryable: false } }));
    expect(auth).not.toHaveBeenCalled(); // no ADC token was even requested
    expect(net).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not log the override value or the token", async () => {
    const lines: string[] = [];
    vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers({ authorization: "Bearer FAKE-ADC-TOKEN" }) as never);
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    await handleAnalyzeMenu(request(), { ...PROD, ...BASE_ENV, GOOGLE_VERTEX_BASE_URL: "https://attacker.example/secret-path" } as AnalyzeEnv);
    expect(lines.join("\n")).not.toContain("attacker");
    expect(lines.join("\n")).not.toContain("secret-path");
    expect(lines.join("\n")).not.toContain("FAKE-ADC-TOKEN");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("defense in depth: the real SDK with a stubbed network", () => {
    const sent: { url: string; auth: string | null }[] = [];
    beforeEach(() => {
      sent.length = 0;
      vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers({ authorization: "Bearer FAKE-ADC-TOKEN" }) as never);
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] }), { status: 200 });
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };

    it("sends to the regional Vertex AI host normally", async () => {
      await createVertexMenuModel(CFG).generate(REQ, { signal: new AbortController().signal, timeoutMs: 1000 });
      expect(sent).toEqual([{ url: expect.stringMatching(/^https:\/\/asia-northeast1-aiplatform\.googleapis\.com\//), auth: "Bearer FAKE-ADC-TOKEN" }]);
    });

    it.each(["GOOGLE_VERTEX_BASE_URL", "GOOGLE_GEMINI_BASE_URL"])(
      "even if %s is set AFTER the config check, no request (and no token) leaves for another host",
      async (name) => {
        vi.stubEnv(name, "https://attacker.example/");
        // Either the call is blocked, or (if the SDK ignores the variable in Vertex mode) it goes to the right host.
        await createVertexMenuModel(CFG)
          .generate(REQ, { signal: new AbortController().signal, timeoutMs: 1000 })
          .catch(() => undefined);
        for (const s of sent) expect(new URL(s.url).hostname).toBe("asia-northeast1-aiplatform.googleapis.com");
        expect(sent.some((s) => s.url.includes("attacker"))).toBe(false);
      },
    );

    it("a blocked endpoint maps to AI_DISABLED and is not retried", async () => {
      vi.stubEnv("GOOGLE_VERTEX_BASE_URL", "https://attacker.example/");
      const r = await analyzeWithGemini(createVertexMenuModel(CFG), CFG, REQ, { requestId: "r", reserveAttempt: async () => PERMIT }, { sleep: async () => {} });
      expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", attempts: 1 });
      expect(sent).toEqual([]);
    });

    it("location 'global' is allowed only for the global host", async () => {
      await createVertexMenuModel({ ...CFG, location: "global" }).generate(REQ, { signal: new AbortController().signal, timeoutMs: 1000 });
      expect(sent[0]!.url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\//);
    });
  });

  it("no module other than vertexClient.ts imports the SDK (no bypass path)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    const importers = files.filter((f) => /from\s+["']@google\/genai["']|require\(["']@google\/genai["']\)/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.replace(process.cwd() + "/", ""))).toEqual(["src/server/gemini/vertexClient.ts"]);
  });
});

describe("mn-1: guarded fetch rules", () => {
  const base = vi.fn(async () => new Response("ok"));
  const guarded = createGuardedFetch("asia-northeast1", base as unknown as typeof fetch);
  it.each([
    "http://asia-northeast1-aiplatform.googleapis.com/v1beta1/x",
    "https://asia-northeast1-aiplatform.googleapis.com:8443/v1beta1/x",
    "https://user:pw@asia-northeast1-aiplatform.googleapis.com/v1beta1/x",
    "https://asia-northeast1-aiplatform.googleapis.com.attacker.example/x",
    "https://us-central1-aiplatform.googleapis.com/v1beta1/x",
    "https://aiplatform.googleapis.com/v1beta1/x",
    "https://generativelanguage.googleapis.com/v1beta/x",
    "not a url",
  ])("blocks %s", async (url) => {
    base.mockClear();
    await expect(guarded(url)).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(base).not.toHaveBeenCalled();
  });
  it("allows the configured regional host (string, URL and Request inputs)", async () => {
    base.mockClear();
    const u = "https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/asia-northeast1/x";
    await guarded(u);
    await guarded(new URL(u));
    await guarded(new Request(u));
    expect(base).toHaveBeenCalledTimes(3);
  });
});
