import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, afterEach } from "vitest";
import Home from "@/app/page";
import { AllergyBridgeApp } from "@/components/AllergyBridgeApp";

afterEach(() => vi.unstubAllEnvs());

describe("Phase A initial UI", () => {
  it.each(["ja", "en"])("defaults to disabled image controls while cards stay usable (%s)", (lang) => {
    const html = renderToStaticMarkup(React.createElement(AllergyBridgeApp, {
      initialStep: "upload",
      initialSettings: { userLang: lang, storeLang: lang === "ja" ? "en" : "ja", allergens: ["egg"] },
    }));
    expect(html).toContain('data-testid="card-only-notice"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="analyze-menu-btn"/);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="upload-to-card-btn"/);
    expect(html).toContain(lang === "ja" ? "画像解析は現在利用できません" : "Image analysis is currently unavailable");
  });

  it.each(["false", "true"])("production page stays card_only even with GEMINI_ENABLED=%s and Mock set", (enabled) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEMINI_ENABLED", enabled);
    vi.stubEnv("MOCK_GEMINI", "true");
    expect(Home().props.analysisAvailable).toBe(false);
    expect(renderToStaticMarkup(Home())).toContain('data-testid="card-only-notice"');
  });

  it("retains explicitly enabled development Mock", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MOCK_GEMINI", "true");
    expect(Home().props.analysisAvailable).toBe(true);
  });
});
