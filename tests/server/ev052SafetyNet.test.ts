import { describe, expect, it, vi } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import type { MenuModel } from "@/server/gemini/vertexClient";
import type { LogEvent } from "@/server/log";
import { blob, fakeJpeg, testUsageGuard } from "./helpers";

/*
 * EV-052 safety net (FAULT INJECTION): simulate a future change that re-injects the
 * model's rationale after conversion. The final check in analyzeWithGemini must
 * fail closed (AI_FAILED) instead of publishing it. Fake model, no network.
 * SYNTHETIC TEST DATA.
 */

const INJECTED = "It is safe to eat.";

vi.mock("@/server/gemini/modelOutput", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/gemini/modelOutput")>();
  return {
    ...mod,
    toPublicCandidate: (...args: Parameters<typeof mod.toPublicCandidate>) => {
      const r = mod.toPublicCandidate(...args);
      if (r.ok) {
        const c = r.candidate as { items: { allergens: { category: string; rationale?: string | null }[] }[] };
        for (const i of c.items) for (const a of i.allergens) if (a.category === "ai_inferred") a.rationale = INJECTED;
      }
      return r;
    },
  };
});

const PROD: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "p", location: "l", model: "m", attemptTimeoutMs: 1_000, requestDeadlineMs: 10_000, maxOutputTokens: 4096 };

describe("EV-052 safety net (re-injection after conversion)", () => {
  it("a rationale re-injected after conversion → AI_FAILED (ai_rationale_not_redacted), never published", async () => {
    const output = {
      status: "ok",
      imageIssues: [],
      items: [{ readText: "Fruit Tart", readability: "clear", allergens: [{ code: "peanut", category: "ai_inferred", rationale: "whatever" }] }],
      menuNotices: [],
    };
    const model: MenuModel = { generate: async () => ({ text: JSON.stringify(output), finishReason: "STOP" }) };
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), PROD, {
      model,
      config: CFG,
      usage: testUsageGuard(),
      logger: (e) => logs.push(e),
    });
    const raw = await res.text();
    // Assertions first (a missing safety net must fail an assertion, not only throw in a parser).
    expect(raw.includes(INJECTED)).toBe(false);
    expect(res.status).toBe(502);
    expect(logs[0]).toMatchObject({ outcome: "error", errorCode: "AI_FAILED", failure: "ai_rationale_not_redacted" });
    const parsed = AnalyzeMenuErrorSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.code).toBe("AI_FAILED");
  });
});
