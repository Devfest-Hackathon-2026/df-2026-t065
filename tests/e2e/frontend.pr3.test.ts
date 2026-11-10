import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ALLERGENS, ALLERGEN_CODES } from "@/contracts/allergens";
import {
  AnalyzeMenuResponseSchema,
  ErrorCodeSchema,
  InvalidInputReasonSchema,
  makeError,
  projectToSelectedAllergens,
  type AnalyzeMenuResponse,
} from "@/contracts/analyze";
import {
  AllergyBridgeApp,
  createInputSnapshot,
  doesSnapshotMatch,
  type AllergyBridgeAppProps,
} from "@/components/AllergyBridgeApp";
import { checkResponseInvariants } from "@/contracts/analyze";
import { MOCK_FIXTURES } from "@/server/mockFixtures";

function renderApp(props: AllergyBridgeAppProps = {}): string {
  return renderToStaticMarkup(React.createElement(AllergyBridgeApp, { analysisAvailable: true, ...props }));
}

function getProjectedFixture(
  scenario: "ok" | "negation_claims" | "cross_contact_notice" | "partial" | "unreadable" | "no_allergen_mentions",
  allergens: typeof ALLERGEN_CODES[number][],
): AnalyzeMenuResponse {
  const raw = AnalyzeMenuResponseSchema.parse(structuredClone(MOCK_FIXTURES[scenario].body));
  const projected = projectToSelectedAllergens(raw, allergens);
  if (!projected.ok) {
    throw new Error(`Unexpected fixture projection failure: ${JSON.stringify(projected.violations)}`);
  }
  return projected.response;
}

describe("PR3 Frontend UI — A. Initial Settings, Separated Language Buttons & Specs Modal", () => {
  it("renders separated button selectors for Language and 店舗で使用されている言語, 11 allergens, and shortened fish note", () => {
    const htmlJa = renderApp({
      initialStep: "settings",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "fish"] },
    });

    // 1. Separated Language Selectors with exact labels & button choices ("日本語", "English")
    expect(htmlJa).toContain('data-testid="user-lang-selector"');
    expect(htmlJa).toContain(">Language<");
    expect(htmlJa).toContain('data-testid="user-lang-btn-ja"');
    expect(htmlJa).toContain('data-testid="user-lang-btn-en"');

    expect(htmlJa).toContain('data-testid="store-lang-selector"');
    expect(htmlJa).toContain("店舗で使用されている言語");
    expect(htmlJa).toContain('data-testid="store-lang-btn-ja"');
    expect(htmlJa).toContain('data-testid="store-lang-btn-en"');

    // All 11 allergens are rendered with checkboxes and no free-text input
    for (const code of ALLERGEN_CODES) {
      expect(htmlJa).toContain(`data-testid="allergen-option-${code}"`);
      expect(htmlJa).toContain(ALLERGENS[code].labels.ja);
      expect(htmlJa).toContain(ALLERGENS[code].labels.en);
    }
    expect(htmlJa).not.toContain('type="text"');

    // 2. Shortened Fish note ("※魚類全般 ※魚種の判別不可")
    expect(htmlJa).toContain('data-testid="scope-note-fish"');
    expect(htmlJa).toContain("※魚類全般 ※魚種の判別不可");

    // 3. Always-visible critical disclaimers & compact storage notice
    expect(htmlJa).toContain('data-testid="persistent-safety-banner"');
    expect(htmlJa).toContain('data-testid="unsupported-allergens-notice"');
    expect(htmlJa).toContain('data-testid="device-storage-notice"');
    expect(htmlJa).toContain("localStorage");

    // Top-right "仕様" button and fixed scrolling background are always present
    expect(htmlJa).toContain('data-testid="fixed-scrolling-bg"');
    expect(htmlJa).toContain('data-testid="specs-modal-trigger"');
    expect(htmlJa).toContain("仕様");
    expect(htmlJa).not.toContain('data-testid="specs-modal-dialog"');
  });

  it("opens the Specs modal popup (仕様) displaying Canvas resize, EXIF removal, and storage specifications", () => {
    const htmlModal = renderApp({
      initialStep: "settings",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
      initialSpecsModalOpen: true,
    });

    expect(htmlModal).toContain('data-testid="specs-modal-dialog"');
    expect(htmlModal).toContain('role="dialog"');
    expect(htmlModal).toContain('aria-modal="true"');
    expect(htmlModal).toContain('data-testid="specs-modal-list"');
    expect(htmlModal).toContain("Canvas");
    expect(htmlModal).toContain("EXIF");
    expect(htmlModal).toContain("localStorage");
  });

  it("switches the entire UI immediately between Japanese (userLang=ja) and English (userLang=en)", () => {
    const htmlJa = renderApp({
      initialStep: "settings",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg"] },
    });
    expect(htmlJa).toContain('data-ui-lang="ja"');
    expect(htmlJa).toContain("重要：このアプリは安全や飲食可否を判定しません");
    expect(htmlJa).toContain("画像撮影・選択へ進む");

    const htmlEn = renderApp({
      initialStep: "settings",
      initialSettings: { userLang: "en", storeLang: "ja", allergens: ["egg"] },
    });
    expect(htmlEn).toContain('data-ui-lang="en"');
    expect(htmlEn).toContain("Important: This app does NOT judge whether food is safe to eat");
    expect(htmlEn).toContain("Continue to Menu Photo Upload");
    expect(htmlEn).toContain("Assessment Scope &amp; Unsupported Allergens Disclaimer");
  });
});

describe("PR3 Frontend UI — B & D. Image Upload, Preview, and Dev Mock Selector", () => {
  it("renders camera capture, file upload, processed image preview with EXIF stripped badge, and dev mock selector in dev mode", () => {
    const validJpegBytes = new Uint8Array(128);
    validJpegBytes.set([0xff, 0xd8, 0xff, 0xe0]);
    const dummyBlob = new Blob([validJpegBytes.buffer as ArrayBuffer], { type: "image/jpeg" });
    const htmlDev = renderApp({
      initialStep: "upload",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
      initialProcessedImage: {
        blob: dummyBlob,
        mimeType: "image/jpeg",
        originalBytes: 2_500_000,
        processedBytes: 420_000,
        width: 1536,
        height: 2048,
        detectedOrientation: 6,
        exifStripped: true,
      },
      initialPreviewUrl: "blob:http://localhost/mock-preview-1",
      nodeEnv: "development",
    });

    expect(htmlDev).toContain('data-testid="camera-file-input"');
    expect(htmlDev).toContain('capture="environment"');
    expect(htmlDev).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(htmlDev).toContain('data-testid="uploaded-menu-preview-img"');
    expect(htmlDev).toContain('data-testid="exif-stripped-badge"');
    expect(htmlDev).toContain('data-testid="orientation-normalized-badge"');
    expect(htmlDev).toContain("1536 × 2048 px");
    // Dev mock selector is visible in non-production
    expect(htmlDev).toContain('data-testid="dev-mock-panel"');
    expect(htmlDev).toContain('data-testid="dev-mock-scenario-select"');
  });

  it("hides the dev mock selector in production", () => {
    const htmlProd = renderApp({
      initialStep: "upload",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
      nodeEnv: "production",
    });
    expect(htmlProd).not.toContain('data-testid="dev-mock-panel"');
    expect(htmlProd).not.toContain('data-testid="dev-mock-scenario-select"');
  });
});

describe("PR3 Frontend UI — C & D. Menu Analysis Results (3 Categories, Absence Claim Warning, Mock Banner)", () => {
  it("displays the mock_fixture warning banner, original image comparison, and separates all 3 categories", () => {
    const response = getProjectedFixture("ok", ["shrimp", "wheat", "egg", "milk"]);
    const html = renderApp({
      initialStep: "results",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "wheat", "egg", "milk"] },
      initialResponse: response,
      initialPreviewUrl: "blob:http://localhost/menu-photo",
    });

    // Mock data warning banner is prominently displayed
    expect(html).toContain('data-testid="mock-fixture-banner"');
    expect(html).toContain("mock_fixture");

    // Original photo comparison and AI misreading notice
    expect(html).toContain('data-testid="image-comparison-panel"');
    expect(html).toContain('data-testid="image-reconciliation"');
    expect(html).toContain("OCR座標がないため、画像上のハイライトは表示しません");
    expect(html).toContain("誤読の可能性あり");
    expect(html).toContain("readBy: ai");

    // 3 distinct categories on item-1 (shrimp: menu_mentions, wheat/egg: ai_inferred, milk: unconfirmed)
    expect(html).toContain('data-testid="dish-item-1-category-menu_mentions"');
    expect(html).toContain('data-testid="dish-item-1-category-ai_inferred"');
    expect(html).toContain('data-testid="dish-item-1-category-unconfirmed"');
    expect(html).toContain("[未確認 / UNCONFIRMED]");
    expect(html).toContain("店員への確認必須");
  });

  it("distinguishes contains_claim, absence_claim, and possible_presence, and NEVER shows absence_claim as safe", () => {
    const negationResponse = getProjectedFixture("negation_claims", ["peanut"]);
    const html = renderApp({
      initialStep: "results",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["peanut"] },
      initialResponse: negationResponse,
    });

    // item-1: contains_claim ("contains peanuts")
    expect(html).toContain('data-testid="assessment-item-1-peanut" data-category="menu_mentions" data-mention-kind="contains_claim"');
    // item-2: absence_claim ("peanut-free") -> must render explicit absence-claim-warning!
    expect(html).toContain('data-testid="assessment-item-2-peanut" data-category="menu_mentions" data-mention-kind="absence_claim"');
    expect(html).toContain('data-testid="absence-claim-warning-item-2-peanut"');
    expect(html).toContain("この記載は飲食可能・安全の保証ではありません");
    // item-3: possible_presence ("may contain peanuts")
    expect(html).toContain('data-testid="assessment-item-3-peanut" data-category="menu_mentions" data-mention-kind="possible_presence"');
  });

  it("displays menu-wide notices (cross_contact_notice) and supports organizing by allergen", () => {
    const crossContactResponse = getProjectedFixture("cross_contact_notice", ["shrimp", "wheat"]);
    const htmlByAllergen = renderApp({
      initialStep: "results",
      initialSettings: { userLang: "en", storeLang: "ja", allergens: ["shrimp", "wheat"] },
      initialResponse: crossContactResponse,
      initialViewMode: "allergen",
    });

    expect(htmlByAllergen).toContain('data-testid="menu-notices-section"');
    expect(htmlByAllergen).toContain("All fried foods are cooked in the same fryer.");
    expect(htmlByAllergen).toContain('data-testid="allergen-view-container"');
    expect(htmlByAllergen).toContain('data-testid="allergen-group-card-shrimp"');
    expect(htmlByAllergen).toContain('data-testid="allergen-group-card-wheat"');
  });

  it("handles unreadable and partial responses gracefully with image issue descriptions", () => {
    const unreadableRes = getProjectedFixture("unreadable", ["shrimp"]);
    const htmlUnreadable = renderApp({
      initialStep: "results",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
      initialResponse: unreadableRes,
    });
    expect(htmlUnreadable).toContain('data-status="unreadable"');
    expect(htmlUnreadable).toContain('data-testid="no-items-message"');
    expect(htmlUnreadable).toContain('data-testid="results-to-card-btn"');
    expect(htmlUnreadable).toContain('data-testid="results-retake-btn"');
  });
});

describe("PR3 Frontend UI — E. Error Screen & PR4 Confirmation Card Placeholder Connection", () => {
  it.each(ErrorCodeSchema.options)(
    "renders error code %s cleanly while preserving Retake Photo and Staff Confirmation Card fallback buttons",
    (code) => {
      const err = makeError(`req-${code}`, code, code === "INVALID_INPUT" ? "image_too_large" : undefined);
      const html = renderApp({
        initialStep: "upload",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
        initialError: err,
      });

      expect(html).toContain('data-testid="error-banner"');
      expect(html).toContain(`data-error-code="${code}"`);
      expect(html).toContain('data-testid="error-retake-btn"');
      expect(html).toContain('data-testid="error-card-fallback-btn"');
    },
  );

  it.each(InvalidInputReasonSchema.options)(
    "renders specific INVALID_INPUT reason message for %s",
    (reason) => {
      const err = makeError(`req-${reason}`, "INVALID_INPUT", reason);
      const html = renderApp({
        initialStep: "upload",
        initialSettings: { userLang: "en", storeLang: "ja", allergens: ["peanut"] },
        initialError: err,
      });
      expect(html).toContain(`data-error-reason="${reason}"`);
      expect(html).toContain('data-testid="error-reason-message"');
    },
  );

  it("renders the PR4 Confirmation Card Placeholder carrying over language pair, selected allergens, and selected dishes", () => {
    const response = getProjectedFixture("ok", ["shrimp", "wheat", "egg", "milk"]);
    const htmlCard = renderApp({
      initialStep: "confirmCard",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "wheat", "egg", "milk"] },
      initialResponse: response,
      initialSelectedDishIds: ["item-1"],
    });

    expect(htmlCard).toContain('data-testid="confirm-card-placeholder-section"');
    expect(htmlCard).toContain('data-testid="verified-card-header-badge"');
    expect(htmlCard).toContain("チーム内検証済み文言");
    expect(htmlCard).toContain('data-testid="card-summary-language-pair"');
    expect(htmlCard).toContain("ja → en");
    expect(htmlCard).toContain('data-testid="card-summary-allergen-shrimp"');
    expect(htmlCard).toContain('data-testid="card-summary-dish-item-1"');
    expect(htmlCard).toContain("Shrimp Tempura - lightly battered shrimp");
    // MAJOR-1: dataOrigin and unverified AI provenance warnings must be carried over to ConfirmationCardPlaceholder
    expect(htmlCard).toContain('data-origin="mock_fixture"');
    expect(htmlCard).toContain('data-testid="card-mock-banner"');
    expect(htmlCard).toContain('data-testid="card-dish-provenance-item-1"');
    expect(htmlCard).toContain("readBy: ai");
  });

  it("distinguishes ai_analysis vs mock_fixture on ConfirmationCardPlaceholder while preserving AI misreading & unverified translation warnings (MAJOR-1)", () => {
    const aiResponse: AnalyzeMenuResponse = {
      ...getProjectedFixture("ok", ["shrimp", "wheat"]),
      dataOrigin: "ai_analysis",
    };
    const htmlAiCard = renderApp({
      initialStep: "confirmCard",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "wheat"] },
      initialResponse: aiResponse,
      initialSelectedDishIds: ["item-1"],
    });

    expect(htmlAiCard).toContain('data-origin="ai_analysis"');
    expect(htmlAiCard).not.toContain('data-testid="card-mock-banner"');
    expect(htmlAiCard).toContain('data-testid="card-dish-provenance-item-1"');
    expect(htmlAiCard).toContain("readBy: ai");
    expect(htmlAiCard).toContain("verified: false");
  });
});

describe("PR3 Audit Regressions — BLOCKER (Snapshot Invalidation), MAJOR-2 (Keyboard Upload Buttons) & Safety Mutations", () => {
  it("invalidates snapshot matching whenever imageId, allergens, language pair, or mockScenario changes (BLOCKER)", () => {
    const baseSnap = createInputSnapshot({
      imageId: "img-a",
      settings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "wheat"] },
      mockScenario: "ok",
    });
    expect(baseSnap).not.toBeNull();

    // Order-insensitive allergen normalization matches identical set
    const reorderedAllergensSnap = createInputSnapshot({
      imageId: "img-a",
      settings: { userLang: "ja", storeLang: "en", allergens: ["wheat", "shrimp"] },
      mockScenario: "ok",
    });
    expect(doesSnapshotMatch(baseSnap, reorderedAllergensSnap)).toBe(true);

    // Changing imageId invalidates match
    const changedImageSnap = createInputSnapshot({
      imageId: "img-b",
      settings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "wheat"] },
      mockScenario: "ok",
    });
    expect(doesSnapshotMatch(baseSnap, changedImageSnap)).toBe(false);

    // Changing allergens invalidates match
    const changedAllergenSnap = createInputSnapshot({
      imageId: "img-a",
      settings: { userLang: "ja", storeLang: "en", allergens: ["milk"] },
      mockScenario: "ok",
    });
    expect(doesSnapshotMatch(baseSnap, changedAllergenSnap)).toBe(false);

    // Changing userLang or storeLang invalidates match
    const changedLangSnap = createInputSnapshot({
      imageId: "img-a",
      settings: { userLang: "en", storeLang: "en", allergens: ["shrimp", "wheat"] },
      mockScenario: "ok",
    });
    expect(doesSnapshotMatch(baseSnap, changedLangSnap)).toBe(false);

    // Changing mockScenario invalidates match
    const changedScenarioSnap = createInputSnapshot({
      imageId: "img-a",
      settings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "wheat"] },
      mockScenario: "negation_claims",
    });
    expect(doesSnapshotMatch(baseSnap, changedScenarioSnap)).toBe(false);

    // Null imageId or empty allergens returns null snapshot and never matches
    expect(
      createInputSnapshot({
        imageId: null,
        settings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
        mockScenario: "ok",
      }),
    ).toBeNull();
    expect(
      createInputSnapshot({
        imageId: "img-a",
        settings: { userLang: "ja", storeLang: "en", allergens: [] },
        mockScenario: "ok",
      }),
    ).toBeNull();
    expect(doesSnapshotMatch(baseSnap, null)).toBe(false);
  });

  it("renders keyboard-focusable button triggers for camera capture and file picker (MAJOR-2)", () => {
    const htmlUpload = renderApp({
      initialStep: "upload",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp"] },
    });

    expect(htmlUpload).toContain('data-testid="camera-capture-btn"');
    expect(htmlUpload).toContain('data-testid="file-picker-btn"');
    expect(htmlUpload).toContain('data-testid="camera-file-input"');
    expect(htmlUpload).toContain('data-testid="upload-file-input"');
  });

  it("rejects safety invariant mutations (confirmationRequired=false, missing allergen, or safety verdict field)", () => {
    const validResponse = getProjectedFixture("ok", ["shrimp", "wheat"]);

    // 1. Missing selected allergen ("milk") is rejected by checkResponseInvariants
    const missingMilkViolations = checkResponseInvariants(validResponse, ["shrimp", "wheat", "milk"]);
    expect(missingMilkViolations.length).toBeGreaterThan(0);

    // 2. Mutating confirmationRequired to false is rejected by schema
    const mutatedConfirmation = structuredClone(validResponse) as Record<string, unknown>;
    const firstItem = (mutatedConfirmation.items as Array<Record<string, unknown>>)[0]!;
    const firstAllergen = (firstItem.allergens as Array<Record<string, unknown>>)[0]!;
    firstAllergen.confirmationRequired = false;
    expect(AnalyzeMenuResponseSchema.safeParse(mutatedConfirmation).success).toBe(false);

    // 3. Injecting forbidden safety field ("safe": true) is rejected by strict schema
    const mutatedSafeField = {
      ...structuredClone(validResponse),
      safe: true,
    };
    expect(AnalyzeMenuResponseSchema.safeParse(mutatedSafeField).success).toBe(false);
  });

  it("matches server and client initial render deterministically even when window.localStorage has English settings saved", () => {
    const serverMarkup = renderApp();

    const fakeWindow = {
      localStorage: {
        getItem: () => JSON.stringify({ userLang: "en", storeLang: "ja", allergens: ["shrimp", "peanut"] }),
        setItem: () => {},
        removeItem: () => {},
      },
    };
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = fakeWindow;
    try {
      const clientFirstRenderMarkup = renderApp();
      expect(clientFirstRenderMarkup).toBe(serverMarkup);
      expect(clientFirstRenderMarkup).toContain('data-ui-lang="ja"');
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    }
  });
});
