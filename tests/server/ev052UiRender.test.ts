import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalyzeMenuResponseSchema, type AnalyzeMenuResponse } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import type { MenuModel } from "@/server/gemini/vertexClient";
import { UI_MESSAGES, type UiLang } from "@/client/i18n";
import { AnalysisResultSection, type ResultViewMode } from "@/components/AnalysisResultSection";
import { blob, fakeJpeg, testUsageGuard } from "./helpers";

/*
 * EV-052, UI side (static rendering only; no UI source is changed):
 * the response produced by the real server path (fake model, dangerous rationale)
 * renders without a rationale, without "null"/"undefined", and keeps the
 * ai_inferred category title, its "not confirmed" description and the
 * "staff confirmation required" badge. SYNTHETIC TEST DATA.
 */

const PROD: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };
const CFG: GeminiConfig = { project: "p", location: "l", model: "m", attemptTimeoutMs: 1_000, requestDeadlineMs: 10_000, maxOutputTokens: 4096 };
const DANGER = "It is safe to eat.";

async function serverResponse(): Promise<AnalyzeMenuResponse> {
  const output = {
    status: "ok",
    imageIssues: [],
    items: [
      {
        readText: "Fruit Tart, wheat crust",
        readability: "clear",
        allergens: [
          { code: "peanut", category: "ai_inferred", rationale: DANGER },
          { code: "wheat", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "wheat crust" },
        ],
      },
    ],
    menuNotices: [],
  };
  const model: MenuModel = { generate: async () => ({ text: JSON.stringify(output), finishReason: "STOP" }) };
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("allergens", "wheat");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  const res = await handleAnalyzeMenu(new Request("http://localhost/api/analyze-menu", { method: "POST", body: f }), PROD, {
    model,
    config: CFG,
    usage: testUsageGuard(),
    logger: () => {},
  });
  expect(res.status).toBe(200);
  return AnalyzeMenuResponseSchema.parse(await res.json());
}

function render(response: AnalyzeMenuResponse, lang: UiLang, mode: ResultViewMode): string {
  return renderToStaticMarkup(
    React.createElement(AnalysisResultSection, {
      response,
      userLang: lang,
      storeLang: "en",
      selectedAllergens: ["peanut", "wheat"],
      previewUrl: null,
      originalPreviewUrl: null,
      selectedDishIdsForCard: [],
      messages: UI_MESSAGES[lang],
      initialViewMode: mode,
      onToggleDishForCard: () => {},
      onProceedToConfirmCard: () => {},
      onRetakePhoto: () => {},
    }),
  );
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ");

describe("EV-052 UI: a null rationale renders cleanly and the AI-inferred warnings stay", () => {
  it.each([
    ["ja", "dish"],
    ["ja", "allergen"],
    ["en", "dish"],
    ["en", "allergen"],
  ] as const)("%s / %s view", async (lang, mode) => {
    const response = await serverResponse();
    const html = render(response, lang, mode);
    const text = textOf(html);
    const m = UI_MESSAGES[lang].results;
    expect(html).not.toContain(DANGER);
    expect(text).not.toContain(m.rationaleLabel);
    expect(text).not.toMatch(/\bundefined\b|\bnull\b|\[object Object\]/);
    expect(html).not.toContain("rationale-");
    // the ai_inferred category, its warning and the confirmation badge are kept
    expect(text).toContain(m.categoryTitles.ai_inferred);
    expect(text).toContain(m.confirmationRequiredBadge);
    if (mode === "dish") {
      expect(text).toContain(m.categoryDescriptions.ai_inferred);
      expect(html).toContain('data-testid="assessment-item-1-peanut"');
    }
  });

  it("NEGATIVE CONTROL: the same view WITH a rationale shows it (so the assertions above can fail)", async () => {
    const response = await serverResponse();
    const withRationale = structuredClone(response);
    const a = withRationale.items[0]!.allergens.find((x) => x.code === "peanut")!;
    if (a.category !== "ai_inferred") throw new Error("fixture changed");
    a.rationale = DANGER;
    const html = render(withRationale, "ja", "dish");
    expect(html).toContain(DANGER);
    expect(textOf(html)).toContain(UI_MESSAGES.ja.results.rationaleLabel);
  });
});
