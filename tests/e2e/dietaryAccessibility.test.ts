import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DIETARY_PRESETS, DIETARY_CONDITIONS } from "@/contracts/dietary";
import { DietarySettingsSection } from "@/components/DietarySettingsSection";
import { DietaryConfirmationCard } from "@/components/DietaryConfirmationCard";

describe("Dietary Restrictions Accessibility & Responsive Contract", () => {
  it("renders accessible roles and aria labels in DietarySettingsSection", () => {
    const html = renderToStaticMarkup(
      React.createElement(DietarySettingsSection, {
        userLang: "ja",
        storeLang: "en",
        settings: {
          activePresets: ["vegan"],
          selectedConditions: ["meat", "fish_seafood"],
        },
        onUpdateSettings: () => {},
        onProceedToDietaryCard: () => {},
      }),
    );

    // Section title and aria-labelledby
    expect(html).toContain("aria-labelledby=\"dietary-settings-title\"");
    expect(html).toContain("id=\"dietary-settings-title\"");

    // Note alert role
    expect(html).toContain("role=\"note\"");

    // Preset button has aria-pressed
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("aria-pressed=\"false\"");

    // Form controls have test IDs
    expect(html).toContain("data-testid=\"dietary-cond-meat\"");
    expect(html).toContain("data-testid=\"dietary-cond-fish_seafood\"");
    expect(html).toContain("data-testid=\"dietary-select-all-btn\"");
    expect(html).toContain("data-testid=\"dietary-clear-all-btn\"");
    expect(html).toContain("data-testid=\"dietary-reset-storage-btn\"");
    expect(html).toContain("data-testid=\"proceed-to-dietary-card-btn\"");
  });

  it("renders accessible roles and buttons in DietaryConfirmationCard", () => {
    const html = renderToStaticMarkup(
      React.createElement(DietaryConfirmationCard, {
        userLang: "en",
        storeLang: "ja",
        selectedConditions: ["pork"],
        onBackToSettings: () => {},
      }),
    );

    expect(html).toContain("data-testid=\"dietary-confirmation-card\"");
    expect(html).toContain("role=\"note\"");
    expect(html).toContain("data-testid=\"dietary-toggle-presentation-btn\"");
    expect(html).toContain("data-testid=\"dietary-reset-answers-btn\"");
    expect(html).toContain("data-testid=\"dietary-back-settings-btn\"");

    // Answer buttons have aria-pressed
    expect(html).toContain("aria-pressed=\"false\"");
  });

  it("all presets have valid sources and rationale for travelers", () => {
    for (const preset of DIETARY_PRESETS) {
      expect(preset.sourceReference.length).toBeGreaterThan(0);
      expect(preset.rationaleJa.length).toBeGreaterThan(0);
      expect(preset.rationaleEn.length).toBeGreaterThan(0);
    }
  });

  it("all conditions have valid categories and localized labels", () => {
    for (const cond of DIETARY_CONDITIONS) {
      expect(["meat_animal_derived", "broth_seasoning", "preparation_equipment"]).toContain(cond.category);
      expect(cond.labelJa.length).toBeGreaterThan(0);
      expect(cond.labelEn.length).toBeGreaterThan(0);
      expect(cond.descriptionJa.length).toBeGreaterThan(0);
      expect(cond.descriptionEn.length).toBeGreaterThan(0);
    }
  });
});
