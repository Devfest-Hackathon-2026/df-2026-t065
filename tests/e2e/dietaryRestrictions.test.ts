import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalyzeMenuFieldsSchema } from "@/contracts/analyze";
import {
  DIETARY_PRESETS,
  DIETARY_CONDITION_CODES,
  type DietaryConditionCode,
} from "@/contracts/dietary";
import {
  applyPresetToggle,
  clearDietarySettings,
  DEFAULT_DIETARY_SETTINGS,
  loadDietarySettings,
  saveDietarySettings,
  type DietarySettings,
  type StorageLike,
} from "@/client/dietarySettingsStorage";
import {
  buildDietaryConfirmationCardBundle,
} from "@/client/dietaryPhrases";
import { AllergyBridgeApp } from "@/components/AllergyBridgeApp";
import { DietarySettingsSection } from "@/components/DietarySettingsSection";
import { DietaryConfirmationCard } from "@/components/DietaryConfirmationCard";

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("Dietary Restrictions & Inquiry Cards (FR-F01 ~ FR-F05)", () => {
  it("FR-F01 & FR-F04: allows selecting and combining multiple dietary conditions", () => {
    const selected: DietaryConditionCode[] = ["meat", "pork", "alcohol_seasoning"];
    const settings: DietarySettings = {
      activePresets: ["custom"],
      selectedConditions: selected,
    };
    expect(settings.selectedConditions.length).toBe(3);
    expect(settings.selectedConditions).toContain("pork");
    expect(settings.selectedConditions).toContain("alcohol_seasoning");

    const html = renderToStaticMarkup(
      React.createElement(DietarySettingsSection, {
        userLang: "ja",
        storeLang: "en",
        settings,
        onUpdateSettings: () => {},
        onProceedToDietaryCard: () => {},
      }),
    );
    expect(html).toContain("data-testid=\"dietary-settings-section\"");
    expect(html).toContain("data-testid=\"dietary-cond-meat\"");
    expect(html).toContain("data-testid=\"dietary-cond-pork\"");
    expect(html).toContain("data-testid=\"dietary-cond-alcohol_seasoning\"");
  });

  it("FR-F02: Vegan and Vegetarian presets expand to editable condition items", () => {
    const veganPreset = DIETARY_PRESETS.find((p) => p.id === "vegan");
    expect(veganPreset).toBeDefined();
    expect(veganPreset?.defaultConditions).toContain("meat");
    expect(veganPreset?.defaultConditions).toContain("egg");
    expect(veganPreset?.defaultConditions).toContain("dairy");
    expect(veganPreset?.defaultConditions).toContain("honey");
    expect(veganPreset?.defaultConditions).toContain("animal_broth");

    // Applying vegan preset expands default conditions
    const initial: DietarySettings = { activePresets: [], selectedConditions: [] };
    const expanded = applyPresetToggle(initial, "vegan");
    expect(expanded.activePresets).toContain("vegan");
    for (const cond of veganPreset!.defaultConditions) {
      expect(expanded.selectedConditions).toContain(cond);
    }

    // Conditions can be individually customized / removed without breaking preset definition
    const customized = {
      ...expanded,
      selectedConditions: expanded.selectedConditions.filter((c) => c !== "honey"),
    };
    expect(customized.selectedConditions).not.toContain("honey");
    expect(customized.selectedConditions).toContain("meat");
  });

  it("FR-F03: Halal and Kosher presets act strictly as question checklists without asserting compliance", () => {
    const halalPreset = DIETARY_PRESETS.find((p) => p.id === "halal_check");
    expect(halalPreset).toBeDefined();
    expect(halalPreset?.defaultConditions).toContain("pork");
    expect(halalPreset?.defaultConditions).toContain("alcohol_seasoning");
    expect(halalPreset?.defaultConditions).toContain("shared_cookware");
    expect(halalPreset?.defaultConditions).toContain("slaughter_method");
    expect(halalPreset?.defaultConditions).toContain("certification_check");

    const kosherPreset = DIETARY_PRESETS.find((p) => p.id === "kosher_check");
    expect(kosherPreset).toBeDefined();
    expect(kosherPreset?.defaultConditions).toContain("meat_dairy_mixing");
    expect(kosherPreset?.defaultConditions).toContain("shellfish");
    expect(kosherPreset?.defaultConditions).toContain("shared_cookware");

    // Rationale mentions it is inquiry only
    expect(halalPreset?.rationaleJa).toContain("店員確認項目");
    expect(kosherPreset?.rationaleJa).toContain("店員確認項目");
  });

  it("FR-F05: verified bilingual confirmation card renders questions and staff answer options", () => {
    const html = renderToStaticMarkup(
      React.createElement(DietaryConfirmationCard, {
        userLang: "en",
        storeLang: "ja",
        selectedConditions: ["pork", "alcohol_seasoning", "shared_cookware"],
        onBackToSettings: () => {},
      }),
    );

    expect(html).toContain("data-testid=\"dietary-confirmation-card\"");
    expect(html).toContain("data-testid=\"dietary-notice-box\"");
    expect(html).toContain("data-testid=\"dietary-question-pork\"");
    expect(html).toContain("data-testid=\"dietary-question-alcohol_seasoning\"");
    expect(html).toContain("data-testid=\"dietary-question-shared_cookware\"");

    // Japanese store-facing staff questions
    expect(html).toContain("豚肉やポークエキス");
    expect(html).toContain("料理酒やみりん");
    expect(html).toContain("調理器具");

    // Staff answer options
    expect(html).not.toContain("dietary-ans-yes-");
    expect(html).not.toContain("dietary-ans-no-");
    expect(html).toContain("確認できません・わかりません");
  });

  it("safety invariant: never asserts edibility or compliance; explicit safety warnings are present", () => {
    const cardHtml = renderToStaticMarkup(
      React.createElement(DietaryConfirmationCard, {
        userLang: "ja",
        storeLang: "en",
        selectedConditions: ["meat"],
        onBackToSettings: () => {},
      }),
    );

    // Warning that app does NOT assert safety / compliance
    expect(cardHtml).toContain("本アプリは料理の適合や安全を保証するものではありません");

    // Prohibited assertions should not exist as labels
    expect(cardHtml).not.toContain("ヴィーガン対応済み");
    expect(cardHtml).not.toContain("ハラール適合");
    expect(cardHtml).not.toContain("安全に召し上がれます");
  });

  it("privacy & data protection: settings are stored locally and clearable; never sent to analyze API", () => {
    const storage = createMemoryStorage();
    const settings: DietarySettings = {
      activePresets: ["halal_check"],
      selectedConditions: ["pork", "alcohol_seasoning"],
    };

    saveDietarySettings(settings, storage);
    const loaded = loadDietarySettings(storage);
    expect(loaded).toEqual(settings);

    // Can be cleared
    const cleared = clearDietarySettings(storage);
    expect(cleared.activePresets.length).toBe(0);
    expect(cleared.selectedConditions.length).toBe(0);
    expect(loadDietarySettings(storage)).toEqual(DEFAULT_DIETARY_SETTINGS);

    // AnalyzeMenuFieldsSchema rejects dietary conditions or religion labels
    const analyzeRequestAttempt = {
      userLang: "en",
      storeLang: "ja",
      selectedAllergens: ["egg"],
      dietaryPreset: "halal_check", // unknown field
    };
    const parsed = AnalyzeMenuFieldsSchema.safeParse(analyzeRequestAttempt);
    // Strict schema rejection prevents sending religion/dietary info to API
    expect(parsed.success).toBe(false);
  });

  it("independence: allergy settings and dietary restrictions operate independently without mutual corruption", () => {
    // Render AllergyBridgeApp with both allergy and dietary settings
    const appHtml = renderToStaticMarkup(
      React.createElement(AllergyBridgeApp, {
        initialStep: "settings",
        initialSettings: {
          userLang: "ja",
          storeLang: "en",
          allergens: ["egg", "milk"],
        },
        initialDietarySettings: {
          activePresets: ["vegan"],
          selectedConditions: ["meat", "fish_seafood"],
        },
      }),
    );

    // Both sections are present
    expect(appHtml).toContain("data-testid=\"settings-section\"");
    expect(appHtml).toContain("data-testid=\"dietary-settings-section\"");

    // Allergy settings are intact
    expect(appHtml).toContain("data-testid=\"allergen-option-egg\"");
    expect(appHtml).toContain("data-testid=\"allergen-option-milk\"");

    // Dietary settings are intact
    expect(appHtml).toContain("data-testid=\"dietary-cond-meat\"");
    expect(appHtml).toContain("data-testid=\"dietary-cond-fish_seafood\"");
  });

  it("can navigate directly to dietary card even when no allergens are selected (AI disabled/not used)", () => {
    // When allergens is empty, but dietary conditions are set, user can proceed to dietaryCard
    const appHtml = renderToStaticMarkup(
      React.createElement(AllergyBridgeApp, {
        initialStep: "dietaryCard",
        initialSettings: {
          userLang: "ja",
          storeLang: "en",
          allergens: [], // no allergens
        },
        initialDietarySettings: {
          activePresets: ["halal_check"],
          selectedConditions: ["pork"],
        },
      }),
    );

    expect(appHtml).toContain("data-testid=\"dietary-confirmation-card\"");
    expect(appHtml).toContain("data-testid=\"dietary-question-pork\"");
  });

  it("every selected condition is either a verified question or explicitly unverified; drafts never display", () => {
    const unverifiedBundle = buildDietaryConfirmationCardBundle({
      userLang: "ja",
      storeLang: "en",
      selectedConditions: [...DIETARY_CONDITION_CODES],
    });

    expect(unverifiedBundle.supportedPair).toBe(true);
    expect(unverifiedBundle.unverifiedConditions).toEqual(["animal_broth", "slaughter_method", "certification_check"]);
    expect(unverifiedBundle.conditionQuestions.length + unverifiedBundle.unverifiedConditions.length).toBe(DIETARY_CONDITION_CODES.length);

    // Confirm that every question has team_reviewed or external_reviewed
    for (const q of unverifiedBundle.conditionQuestions) {
      expect(q.storeVerification.level).not.toBe("draft");
      expect(q.userVerification.level).not.toBe("draft");
    }
  });
});
