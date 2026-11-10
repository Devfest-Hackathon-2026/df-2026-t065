import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmationCardPlaceholder } from "@/components/ConfirmationCardPlaceholder";
import { UI_MESSAGES } from "@/client/i18n";

const phraseId = "Q_ALLERGEN_SHRIMP";

describe("confirmation card editor accessible validation", () => {
  for (const userLang of ["ja", "en"] as const) {
    for (const invalidInput of ["", "x".repeat(301)]) {
      it(`${userLang}: connects each invalid field to its localized error and help (${invalidInput.length} chars)`, () => {
        const messages = UI_MESSAGES[userLang];
        const html = renderToStaticMarkup(React.createElement(ConfirmationCardPlaceholder, {
          userLang,
          storeLang: userLang === "ja" ? "en" : "ja",
          selectedAllergens: ["shrimp"], targetItems: [], dataOrigin: null,
          hasAnalysisResult: false, messages,
          initialPhraseEdits: { [phraseId]: { storeText: invalidInput, userText: invalidInput } },
          initialEditingPhraseIds: [phraseId],
          onBackToResults() {}, onBackToUpload() {}, onBackToSettings() {},
        }));
        for (const field of ["store", "user"]) {
          const input = html.match(new RegExp(`<textarea id="edit-${field}-${phraseId}"[^>]*>`))?.[0];
          expect(input).toContain('aria-invalid="true"');
          expect(input).toContain(`aria-describedby="edit-${field}-count-${phraseId} edit-hint-${phraseId} edit-${field}-error-${phraseId}"`);
          expect(html).toContain(`id="edit-${field}-error-${phraseId}"`);
          expect(html).toContain(`id="edit-${field}-count-${phraseId}"`);
        }
        expect(html).toContain(`id="edit-hint-${phraseId}"`);
        expect(html).toContain(invalidInput.length ? messages.confirmCard.editInvalidLengthError(300) : messages.confirmCard.editInvalidEmptyError);
        expect(html).toContain('data-can-present="false"');
      });
    }
  }
});
