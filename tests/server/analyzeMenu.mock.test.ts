import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema, AnalyzeMenuResponseSchema, checkResponseInvariants } from "@/contracts/analyze";
import { MOCK_SCENARIO_HEADER, handleAnalyzeMenu, isMockModeEnabled, type AnalyzeEnv } from "@/server/analyzeMenu";
import { blob, fakeJpeg } from "./helpers";

const QUIET = { logger: () => {} };

const MOCK_DEV: AnalyzeEnv = { NODE_ENV: "development", MOCK_GEMINI: "true" };

function request(opts: { allergens?: string[]; scenario?: string; userLang?: string; storeLang?: string } = {}): Request {
  const f = new FormData();
  f.append("userLang", opts.userLang ?? "ja");
  f.append("storeLang", opts.storeLang ?? "en");
  for (const a of opts.allergens ?? ["shrimp", "peanut"]) f.append("allergens", a);
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "menu.jpg");
  const headers = opts.scenario ? { [MOCK_SCENARIO_HEADER]: opts.scenario } : undefined;
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f, headers });
}

describe("mock mode conditions", () => {
  it("is enabled only when MOCK_GEMINI=true outside production", () => {
    expect(isMockModeEnabled({ NODE_ENV: "development", MOCK_GEMINI: "true" })).toBe(true);
    expect(isMockModeEnabled({ NODE_ENV: "test", MOCK_GEMINI: "true" })).toBe(true);
    expect(isMockModeEnabled({ NODE_ENV: "production", MOCK_GEMINI: "true" })).toBe(false);
    expect(isMockModeEnabled({ NODE_ENV: "development", MOCK_GEMINI: "1" })).toBe(false);
    expect(isMockModeEnabled({ NODE_ENV: "development" })).toBe(false);
  });

  it("never serves mock data in production, even with MOCK_GEMINI=true", async () => {
    const res = await handleAnalyzeMenu(request(), { NODE_ENV: "production", MOCK_GEMINI: "true" }, QUIET);
    expect(res.status).toBe(503);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
  });

  it("returns AI_DISABLED when mock mode is off (real AI is PR2)", async () => {
    const res = await handleAnalyzeMenu(request(), { NODE_ENV: "development" }, QUIET);
    expect(res.status).toBe(503);
  });
});

describe("mock route behaviour", () => {
  it("serves the ok fixture aligned to the selected allergens, marked as mock data", async () => {
    const res = await handleAnalyzeMenu(request({ allergens: ["shrimp", "peanut"] }), MOCK_DEV, { ...QUIET, newRequestId: () => "req-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = AnalyzeMenuResponseSchema.parse(await res.json());
    expect(body.requestId).toBe("req-1");
    expect(body.dataOrigin).toBe("mock_fixture");
    expect(checkResponseInvariants(body, ["shrimp", "peanut"])).toEqual([]);
    // peanut is not in the fixture → filled in as unconfirmed, never as absent
    const peanut = body.items[0]!.allergens.find((a) => a.code === "peanut");
    expect(peanut).toEqual({ code: "peanut", category: "unconfirmed", reason: "not_assessed", confirmationRequired: true });
  });

  it.each(["partial", "unreadable", "injection_in_image", "negation_claims", "no_allergen_mentions", "cross_contact_notice"])(
    "serves the %s fixture as a contract-valid response",
    async (scenario) => {
      const res = await handleAnalyzeMenu(request({ scenario }), MOCK_DEV, QUIET);
      expect(res.status).toBe(200);
      AnalyzeMenuResponseSchema.parse(await res.json());
    },
  );

  it("fails safe (AI_FAILED) on invalid model output instead of passing it through", async () => {
    const res = await handleAnalyzeMenu(request({ scenario: "invalid_output_raw" }), MOCK_DEV, QUIET);
    expect(res.status).toBe(502);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
  });

  // MAJOR-1 regression: before the fix, alignment kept the first duplicate and
  // silently dropped the rest (e.g. a "contains" mention), returning 200.
  it.each([[["peanut", "milk"]], [["milk", "peanut"]], [["peanut"]], [["egg"]]])(
    "fails safe (AI_FAILED) on duplicated/conflicting assessments, selection %j",
    async (selection) => {
      const res = await handleAnalyzeMenu(request({ scenario: "conflicting_assessments_raw", allergens: selection }), MOCK_DEV, QUIET);
      expect(res.status).toBe(502);
      expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
    },
  );

  // MAJOR-2 (re-audit) regression: invisible-only evidence must never be returned as a menu mention.
  it("fails safe (AI_FAILED) when readText/excerpt contain only invisible characters", async () => {
    const res = await handleAnalyzeMenu(request({ scenario: "invisible_evidence_raw", allergens: ["peanut"] }), MOCK_DEV, QUIET);
    expect(res.status).toBe(502);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_FAILED");
  });

  it("rejects unknown form fields at the route (MINOR-1)", async () => {
    const req = request();
    const f = await req.formData();
    f.append("debug", "1");
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), MOCK_DEV, QUIET);
    expect(res.status).toBe(400);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.reason).toBe("malformed_request");
  });

  it("serves the timeout error fixture", async () => {
    const res = await handleAnalyzeMenu(request({ scenario: "error_ai_timeout" }), MOCK_DEV, QUIET);
    expect(res.status).toBe(504);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error).toEqual({ code: "AI_TIMEOUT", retryable: true });
  });

  it("validates input before anything else", async () => {
    const res = await handleAnalyzeMenu(request({ storeLang: "fr" }), MOCK_DEV, QUIET);
    expect(res.status).toBe(400);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.reason).toBe("unsupported_language_pair");
  });

  it("rejects unknown scenarios and non-multipart bodies", async () => {
    expect((await handleAnalyzeMenu(request({ scenario: "../../etc/passwd" }), MOCK_DEV, QUIET)).status).toBe(400);
    const bad = new Request("http://localhost/api/analyze-menu", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await handleAnalyzeMenu(bad, MOCK_DEV, QUIET)).status).toBe(400);
  });

  it("rejects oversized bodies by declared content-length", async () => {
    const big = new Request("http://localhost/api/analyze-menu", {
      method: "POST",
      body: "x",
      headers: { "content-length": String(10 * 1024 * 1024) },
    });
    const res = await handleAnalyzeMenu(big, MOCK_DEV, QUIET);
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.reason).toBe("image_too_large");
  });
});
