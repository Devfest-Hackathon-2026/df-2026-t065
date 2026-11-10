import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  AllergyBridgeApp,
  type AllergyBridgeAppProps,
} from "@/components/AllergyBridgeApp";
import { setSimulatedOnlineStatus } from "@/client/onlineStatus";
import { makeError } from "@/contracts/analyze";

function renderApp(props: AllergyBridgeAppProps = {}): string {
  return renderToStaticMarkup(React.createElement(AllergyBridgeApp, props));
}

describe("Offline Confirmation Card UI & Flow Verification", () => {
  beforeEach(() => {
    setSimulatedOnlineStatus(null);
  });

  afterEach(() => {
    setSimulatedOnlineStatus(null);
  });

  describe("1. Offline Status Banner & Card Navigation", () => {
    it("renders offline banner with badge and card shortcut when offline", () => {
      setSimulatedOnlineStatus(false);

      const html = renderApp({
        initialStep: "settings",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg", "milk"] },
      });

      expect(html).toContain('data-testid="offline-status-banner"');
      expect(html).toContain('data-testid="offline-badge"');
      expect(html).toContain("オフライン");
      expect(html).toContain("オフラインで利用中");
      expect(html).toContain('data-testid="offline-go-to-card-btn"');
      expect(html).toContain("店員確認カードを表示");
    });

    it("does not render offline banner when online", () => {
      setSimulatedOnlineStatus(true);

      const html = renderApp({
        initialStep: "settings",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg"] },
      });

      expect(html).not.toContain('data-testid="offline-status-banner"');
    });

    it("renders English offline banner when userLang is en", () => {
      setSimulatedOnlineStatus(false);

      const html = renderApp({
        initialStep: "settings",
        initialSettings: { userLang: "en", storeLang: "ja", allergens: ["peanut"] },
      });

      expect(html).toContain('data-testid="offline-status-banner"');
      expect(html).toContain("Working Offline");
      expect(html).toContain("Offline");
      expect(html).toContain("View Confirmation Card");
    });
  });

  describe("2. Offline Image Upload & Analysis Suppression", () => {
    it("disables analyze button and renders offline hint when offline", () => {
      setSimulatedOnlineStatus(false);

      const fakeImage = {
        blob: new Blob(["dummy-image"], { type: "image/jpeg" }),
        width: 1000,
        height: 800,
        byteSize: 1024,
        originalBytes: 1024,
        processedBytes: 1024,
        detectedOrientation: 1 as const,
        mimeType: "image/jpeg" as const,
        exifStripped: true as const,

      };

      const html = renderApp({
        initialStep: "upload",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["wheat"] },
        initialProcessedImage: fakeImage,
      });

      // Analyze button must be disabled when offline
      expect(html).toContain('data-testid="analyze-menu-btn"');
      expect(html).toContain('disabled=""');

      // Offline hint must be shown
      expect(html).toContain('data-testid="offline-analyze-hint"');
      expect(html).toContain("オフラインのためAI解析は実行できません");

      // Staff confirmation card button remains fully enabled and visible
      expect(html).toContain('data-testid="upload-to-card-btn"');
      expect(html).toContain("AIを使わず店員確認へ");
    });
  });

  describe("3. Offline Confirmation Card Rendering", () => {
    it("renders verified confirmation cards and staff response choices without network", () => {
      setSimulatedOnlineStatus(false);

      const html = renderApp({
        initialStep: "confirmCard",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg", "milk"] },
      });

      // Card container and section title
      expect(html).toContain('data-testid="confirm-card-placeholder-section"');
      expect(html).toContain("店員向け確認カード");

      // Verified questions for both egg and milk
      expect(html).toContain('data-testid="phrase-card-Q_ALLERGEN_EGG"');
      expect(html).toContain('data-testid="phrase-card-Q_ALLERGEN_MILK"');

      // Cross-contact notice and questions
      expect(html).toContain('data-testid="phrase-card-Q_CROSS_CONTACT"');
      expect(html).toContain('data-testid="phrase-card-Q_FRYING_OIL"');

      // Staff answer option buttons
      expect(html).toContain('data-testid="staff-answer-btn-ANS_CONTAINS"');
      expect(html).toContain('data-testid="staff-answer-btn-ANS_DOES_NOT_CONTAIN"');

      // Navigation back to settings remains functional
      expect(html).toContain('data-testid="card-back-to-settings-btn"');
    });
  });

  describe("4. Clear Distinction Between AI Errors and App Offline", () => {
    it("renders ErrorBanner when AI fails online, distinguishable from offline banner", () => {
      setSimulatedOnlineStatus(true);

      const html = renderApp({
        initialStep: "upload",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["wheat"] },
        initialError: makeError("req-test-ai-disabled", "AI_DISABLED"),
      });

      // Error banner for AI_DISABLED is present
      expect(html).toContain('data-testid="error-banner"');
      expect(html).toContain("AI_DISABLED");

      // Offline status banner is NOT present
      expect(html).not.toContain('data-testid="offline-status-banner"');
    });
  });
});
