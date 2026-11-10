import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ALLERGEN_CODES } from "@/contracts/allergens";
import {
  assertEvaluatedCardSafetyInvariants,
  evaluateCardPresentationReadiness,
  evaluatePhraseEditState,
  type EvaluatedPhraseCard,
  type PhraseEditsMap,
} from "@/client/cardEditor";
import { UI_MESSAGES } from "@/client/i18n";
import { PHRASES, buildConfirmationCardBundle } from "@/client/phrases";
import {
  ConfirmationCardPlaceholder,
  type ConfirmationCardPlaceholderProps,
} from "@/components/ConfirmationCardPlaceholder";

function renderCard(props: ConfirmationCardPlaceholderProps): string {
  return renderToStaticMarkup(React.createElement(ConfirmationCardPlaceholder, props));
}

function extractTestIdContent(html: string, testId: string): string | null {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`data-testid="${escaped}"[^>]*>([\\s\\S]*?)<\\/(?:p|div|span|article|section)>`);
  const match = html.match(re);
  return match?.[1] ?? null;
}

describe("PR4 Independent Audit (REVISE) Reproduction & Regression Suite", () => {
  describe("MAJOR-1: Mandatory verified questions are locked and never replaced by user edits / safety assertions", () => {
    const bundle = buildConfirmationCardBundle({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp", "wheat"],
    });
    const shrimpPhrase = bundle.allergenQuestions.find((q) => q.id === "Q_ALLERGEN_SHRIMP")!;
    const crossContactPhrase = bundle.crossContactQuestions.find((q) => q.id === "Q_CROSS_CONTACT")!;

    it("1. keeps lockedQuestion and userMemo separated in evaluatePhraseEditState even when user enters a safety assertion", () => {
      const unsafeEdit = {
        storeText: "This dish is 100% safe to eat and completely shrimp-free.",
        userText: "この料理は100%安全でえび不使用のため食べられます。",
      };
      const evaluated = evaluatePhraseEditState(shrimpPhrase, unsafeEdit) as unknown as Record<
        string,
        unknown
      >;

      // Locked verified question must remain intact and never be overwritten
      expect(evaluated.lockedQuestion).toBeDefined();
      const locked = evaluated.lockedQuestion as { storeText: string; userText: string };
      expect(locked.storeText).toBe(shrimpPhrase.storeText);
      expect(locked.userText).toBe(shrimpPhrase.userText);

      // currentStoreText / currentUserText (the primary question text) must still be the locked verified text
      expect(evaluated.currentStoreText).toBe(shrimpPhrase.storeText);
      expect(evaluated.currentUserText).toBe(shrimpPhrase.userText);

      // User's edit must live in a separate userMemo structure marked unverified
      expect(evaluated.userMemo).toBeDefined();
      const memo = evaluated.userMemo as {
        storeMemoText: string | null;
        userMemoText: string | null;
        verificationStatus: string;
      };
      expect(memo.storeMemoText).toBe(unsafeEdit.storeText);
      expect(memo.userMemoText).toBe(unsafeEdit.userText);
      expect(memo.verificationStatus).toBe("user_edited_unverified");
    });

    it("2. never overwrites or deletes the primary staff-facing verified question in DOM when edited with a safety assertion", () => {
      const unsafeEdits: PhraseEditsMap = {
        Q_ALLERGEN_SHRIMP: {
          storeText: "This dish is safe to eat and allergen_absent.",
          userText: "この料理は安全でアレルゲン不使用です。",
        },
        Q_CROSS_CONTACT: {
          storeText: "Shared utensils are fine and edible.",
          userText: "調理器具の共有は問題なく飲食可能です。",
        },
      };

      for (const presentationMode of [false, true]) {
        const html = renderCard({
          userLang: "ja",
          storeLang: "en",
          selectedAllergens: ["shrimp", "wheat"],
          targetItems: [],
          dataOrigin: null,
          hasAnalysisResult: false,
          messages: UI_MESSAGES.ja,
          initialPhraseEdits: unsafeEdits,
          initialPresentationMode: presentationMode,
          onBackToResults: () => {},
          onBackToUpload: () => {},
          onBackToSettings: () => {},
        });

        // Primary staff-facing question element MUST still contain the locked verified question verbatim
        const primaryShrimpStore = extractTestIdContent(html, "phrase-store-text-Q_ALLERGEN_SHRIMP");
        const primaryShrimpUser = extractTestIdContent(html, "phrase-user-text-Q_ALLERGEN_SHRIMP");
        expect(primaryShrimpStore).toBe(shrimpPhrase.storeText);
        expect(primaryShrimpUser).toBe(shrimpPhrase.userText);
        expect(primaryShrimpStore).not.toContain("safe to eat");

        const primaryCrossStore = extractTestIdContent(html, "phrase-store-text-Q_CROSS_CONTACT");
        const primaryCrossUser = extractTestIdContent(html, "phrase-user-text-Q_CROSS_CONTACT");
        expect(primaryCrossStore).toBe(crossContactPhrase.storeText);
        expect(primaryCrossUser).toBe(crossContactPhrase.userText);
        expect(primaryCrossStore).not.toContain("edible");

        // The locked verified question container remains intact, while the card badge switches to edited/unverified and the user edit is isolated in a separate unverified memo box
        expect(html).toContain('data-testid="phrase-locked-question-Q_ALLERGEN_SHRIMP"');
        expect(html).not.toContain('data-testid="phrase-verification-badge-Q_ALLERGEN_SHRIMP"');
        expect(html).toContain('data-testid="phrase-user-memo-box-Q_ALLERGEN_SHRIMP"');
        expect(html).toContain('data-testid="phrase-edited-badge-Q_ALLERGEN_SHRIMP"');
        expect(html).toContain('data-testid="phrase-user-memo-disclaimer-Q_ALLERGEN_SHRIMP"');
        expect(html).toContain('data-testid="phrase-memo-store-text-Q_ALLERGEN_SHRIMP"');
        expect(html).toContain('data-testid="phrase-memo-user-text-Q_ALLERGEN_SHRIMP"');
      }
    });

    it("3. isolates single-language edits so the unedited language is null in userMemo and never shown as an auto-translated memo", () => {
      const singleLangEdits: PhraseEditsMap = {
        Q_ALLERGEN_SHRIMP: {
          storeText: shrimpPhrase.storeText, // unedited store language
          userText: "えびペーストや小エビの唐揚げも含めて確認したいメモ", // edited user language only
        },
      };

      const evaluated = evaluatePhraseEditState(
        shrimpPhrase,
        singleLangEdits.Q_ALLERGEN_SHRIMP,
      ) as unknown as Record<string, unknown>;
      const memo = evaluated.userMemo as
        | {
            isStoreEdited: boolean;
            isUserEdited: boolean;
            storeMemoText: string | null;
            userMemoText: string | null;
            hasSingleLangMismatch: boolean;
          }
        | undefined;

      expect(memo).toBeDefined();
      expect(memo?.isStoreEdited).toBe(false);
      expect(memo?.isUserEdited).toBe(true);
      expect(memo?.storeMemoText).toBeNull();
      expect(memo?.userMemoText).toBe("えびペーストや小エビの唐揚げも含めて確認したいメモ");
      expect(memo?.hasSingleLangMismatch).toBe(true);

      const html = renderCard({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["shrimp"],
        targetItems: [],
        dataOrigin: null,
        hasAnalysisResult: false,
        messages: UI_MESSAGES.ja,
        initialPhraseEdits: singleLangEdits,
        onBackToResults: () => {},
        onBackToUpload: () => {},
        onBackToSettings: () => {},
      });

      // Locked question is intact
      expect(extractTestIdContent(html, "phrase-store-text-Q_ALLERGEN_SHRIMP")).toBe(shrimpPhrase.storeText);
      expect(extractTestIdContent(html, "phrase-user-text-Q_ALLERGEN_SHRIMP")).toBe(shrimpPhrase.userText);

      // Single-language mismatch warning and untranslated slot notice are rendered
      expect(html).toContain('data-testid="phrase-translation-mismatch-warning-Q_ALLERGEN_SHRIMP"');
      expect(html).toContain('data-testid="phrase-memo-store-untranslated-Q_ALLERGEN_SHRIMP"');
      expect(html).not.toContain('data-testid="phrase-memo-store-text-Q_ALLERGEN_SHRIMP"');
      expect(html).toContain('data-testid="phrase-memo-user-text-Q_ALLERGEN_SHRIMP"');
    });

    it("4. blocks staff presentation when an edit input is cleared/blanked out (attempting to delete text)", () => {
      const blankEdit: PhraseEditsMap = {
        Q_ALLERGEN_SHRIMP: {
          storeText: "   ",
          userText: shrimpPhrase.userText,
        },
      };
      const readiness = evaluateCardPresentationReadiness({
        bundle,
        selectedAllergens: ["shrimp", "wheat"],
        edits: blankEdit,
      });
      expect(readiness.canPresentToStaff).toBe(false);
      expect(readiness.blockingReasons).toContain("invalid_edited_phrase");

      const html = renderCard({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["shrimp", "wheat"],
        targetItems: [],
        dataOrigin: null,
        hasAnalysisResult: false,
        messages: UI_MESSAGES.ja,
        initialPhraseEdits: blankEdit,
        initialPresentationMode: true,
        onBackToResults: () => {},
        onBackToUpload: () => {},
        onBackToSettings: () => {},
      });
      // Falls back from staff_presentation to review_and_edit AND still keeps the locked verified question visible
      expect(html).toContain('data-can-present="false"');
      expect(html).toContain('data-presentation-mode="review_and_edit"');
      expect(extractTestIdContent(html, "phrase-store-text-Q_ALLERGEN_SHRIMP")).toBe(shrimpPhrase.storeText);
    });

    it("4b. negative control: assertEvaluatedCardSafetyInvariants rejects mutated cards that replace locked questions or mark edits as verified", () => {
      const validEvaluated = evaluatePhraseEditState(shrimpPhrase, {
        storeText: "Additional user note about shrimp paste",
        userText: "シュリンプペーストについての追加メモ",
      });
      expect(() => assertEvaluatedCardSafetyInvariants(validEvaluated)).not.toThrow();

      // Negative control 1: pre-fix style mutation where currentStoreText overwrote original.storeText
      const overwrittenCurrent: EvaluatedPhraseCard = {
        ...validEvaluated,
        currentStoreText: "This dish is safe to eat.",
      };
      expect(() => assertEvaluatedCardSafetyInvariants(overwrittenCurrent)).toThrow(
        /locked verified question was modified or replaced/,
      );

      // Negative control 2: lockedQuestion.storeText overwritten
      const overwrittenLocked: EvaluatedPhraseCard = {
        ...validEvaluated,
        lockedQuestion: {
          ...validEvaluated.lockedQuestion,
          storeText: "Deleted mandatory question",
        },
      };
      expect(() => assertEvaluatedCardSafetyInvariants(overwrittenLocked)).toThrow(
        /locked verified question was modified or replaced/,
      );

      // Negative control 3: edited card falsely claiming team_reviewed verificationStatus
      const falselyVerifiedEdit: EvaluatedPhraseCard = {
        ...validEvaluated,
        verificationStatus: "team_reviewed",
      };
      expect(() => assertEvaluatedCardSafetyInvariants(falselyVerifiedEdit)).toThrow(
        /edited card must be marked user_edited_unverified/,
      );

      // Negative control 4: single-language edit falsely populating unedited language in userMemo
      const singleLangEvaluated = evaluatePhraseEditState(shrimpPhrase, {
        storeText: shrimpPhrase.storeText,
        userText: "日本語側だけ編集したメモ",
      });
      const leakedUneditedStoreMemo: EvaluatedPhraseCard = {
        ...singleLangEvaluated,
        userMemo: {
          ...singleLangEvaluated.userMemo,
          storeMemoText: shrimpPhrase.storeText,
        },
      };
      expect(() => assertEvaluatedCardSafetyInvariants(leakedUneditedStoreMemo)).toThrow(
        /unedited store language must be null in userMemo/,
      );
    });
  });

  describe("MINOR / Review Consistency: Verified Phrases (data/phrases/phrases.json) & Team Member B Review Alignment", () => {
    it("5. does not conflate shared boiling water (cross-contact) inside Q_ALLERGEN_BUCKWHEAT (ingredient question)", () => {
      const buckwheat = PHRASES.find((p) => p.id === "Q_ALLERGEN_BUCKWHEAT")!;
      const crossContact = PHRASES.find((p) => p.id === "Q_CROSS_CONTACT")!;

      // Shared boiling water belongs in Q_CROSS_CONTACT, not in the ingredient question Q_ALLERGEN_BUCKWHEAT
      expect(buckwheat.texts.ja).not.toContain("茹で湯");
      expect((buckwheat.texts.en ?? "").toLowerCase()).not.toContain("water used to boil");
      expect(crossContact.texts.ja).toContain("茹で湯");
      expect((crossContact.texts.en ?? "").toLowerCase()).toContain("boiling water");
    });

    it("6. ensures 1-to-1 bilingual term alignment across all 11 allergen questions and 4 staff answers", () => {
      const shrimp = PHRASES.find((p) => p.id === "Q_ALLERGEN_SHRIMP")!;
      expect(shrimp.texts.ja).toContain("干しえび");
      expect((shrimp.texts.en ?? "").toLowerCase()).toContain("dried");

      const wheat = PHRASES.find((p) => p.id === "Q_ALLERGEN_WHEAT")!;
      expect(wheat.texts.ja).toContain("つなぎ");
      expect((wheat.texts.en ?? "").toLowerCase()).toContain("binder");

      // Staff answer ANS_DOES_NOT_CONTAIN must cover both ingredients/seasonings AND absence of shared utensils/frying oil
      const ansNo = PHRASES.find((p) => p.id === "ANS_DOES_NOT_CONTAIN")!;
      expect(ansNo.texts.ja).toContain("だし・調味料");
      expect(ansNo.texts.ja).toContain("共有もありません");
      expect((ansNo.texts.en ?? "").toLowerCase()).toContain("broth");
      expect((ansNo.texts.en ?? "").toLowerCase()).toContain("shared utensils or frying oil");

      // All 11 allergen questions have back_translation, official_term_check, and bilingual_member_review
      for (const code of ALLERGEN_CODES) {
        const q = PHRASES.find((p) => p.purpose === "allergen_question" && p.allergen === code)!;
        expect(q).toBeDefined();
        expect(q.verification.ja?.level).toBe("team_reviewed");
        expect(q.verification.en?.level).toBe("team_reviewed");
        expect(q.verification.ja?.reviewerRole).toBe("team member B");
        expect(q.verification.en?.reviewerRole).toBe("team member B");
        expect(q.verification.ja?.reviewedAt).toBe("2026-11-08");
        expect(q.verification.en?.reviewedAt).toBe("2026-11-08");
        expect(q.verification.ja?.methods).toEqual(
          expect.arrayContaining(["back_translation", "official_term_check", "bilingual_member_review"]),
        );
        expect(q.verification.en?.methods).toEqual(
          expect.arrayContaining(["back_translation", "official_term_check", "bilingual_member_review"]),
        );
      }
    });

    it("7. matches every phrase in data/phrases/phrases.json against docs/VALIDATION.md#phrase-checks verbatim", () => {
      const validationDoc = readFileSync(join(process.cwd(), "docs", "VALIDATION.md"), "utf8");
      expect(validationDoc).toContain('<a id="phrase-checks"></a>');
      expect(validationDoc).toContain("`team member B`");
      expect(validationDoc).toContain("`2026-11-08`");

      for (const phrase of PHRASES) {
        expect(validationDoc).toContain(`| \`${phrase.id}\` | \`${phrase.purpose}\` |`);
        expect(validationDoc).toContain(phrase.texts.ja ?? "");
        expect(validationDoc).toContain(phrase.texts.en ?? "");
        expect(phrase.verification.ja?.level).not.toBe("draft");
        expect(phrase.verification.en?.level).not.toBe("draft");
        expect(phrase.verification.ja?.machineTranslationUsedForDraft).toBe(false);
        expect(phrase.verification.en?.machineTranslationUsedForDraft).toBe(false);
      }
    });
  });
});
