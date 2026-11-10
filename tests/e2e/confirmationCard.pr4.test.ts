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
import { PhraseSchema, isDisplayable, type Phrase } from "@/contracts/phrases";
import {
  MAX_EDITED_PHRASE_LENGTH,
  createCardEditSessionKey,
  evaluateCardPresentationReadiness,
  evaluatePhraseEditState,
  sanitizeEditedPhraseInput,
  validateEditedPhraseText,
} from "@/client/cardEditor";
import { UI_MESSAGES } from "@/client/i18n";
import {
  PHRASES,
  PhraseDatasetSchema,
  buildConfirmationCardBundle,
  resolveBilingualPhrase,
} from "@/client/phrases";
import { AllergyBridgeApp, type AllergyBridgeAppProps } from "@/components/AllergyBridgeApp";
import {
  ConfirmationCardPlaceholder,
  type ConfirmationCardPlaceholderProps,
} from "@/components/ConfirmationCardPlaceholder";
import { MOCK_FIXTURES } from "@/server/mockFixtures";

function renderApp(props: AllergyBridgeAppProps = {}): string {
  return renderToStaticMarkup(React.createElement(AllergyBridgeApp, { analysisAvailable: true, ...props }));
}

function renderCard(props: ConfirmationCardPlaceholderProps): string {
  return renderToStaticMarkup(React.createElement(ConfirmationCardPlaceholder, props));
}

function getProjectedFixture(
  scenario: "ok" | "negation_claims" | "cross_contact_notice" | "partial" | "unreadable" | "no_allergen_mentions",
  allergens: (typeof ALLERGEN_CODES)[number][],
): AnalyzeMenuResponse {
  const raw = AnalyzeMenuResponseSchema.parse(structuredClone(MOCK_FIXTURES[scenario].body));
  const projected = projectToSelectedAllergens(raw, allergens);
  if (!projected.ok) {
    throw new Error(`Unexpected fixture projection failure: ${JSON.stringify(projected.violations)}`);
  }
  return projected.response;
}

describe("PR4 Phrase Data & Verification Contract (data/phrases/phrases.json)", () => {
  it("validates all entries in data/phrases/phrases.json against PhraseDatasetSchema and PhraseSchema", () => {
    const parsed = PhraseDatasetSchema.safeParse(PHRASES);
    expect(parsed.success).toBe(true);
    expect(PHRASES.length).toBe(19); // 1 notice + 11 allergens + 3 cross-contact/broth/oil + 4 staff answers

    for (const phrase of PHRASES) {
      expect(PhraseSchema.safeParse(phrase).success).toBe(true);
      expect(isDisplayable(phrase, "ja")).toBe(true);
      expect(isDisplayable(phrase, "en")).toBe(true);
      expect(phrase.verification.ja?.level).toBe("team_reviewed");
      expect(phrase.verification.en?.level).toBe("team_reviewed");
      expect(phrase.verification.ja?.methods).toContain("back_translation");
      expect(phrase.verification.en?.methods).toContain("back_translation");
      expect(phrase.verification.ja?.evidence).toBe("docs/VALIDATION.md#phrase-checks");
      expect(phrase.verification.en?.evidence).toBe("docs/VALIDATION.md#phrase-checks");
    }
  });

  it("includes verified allergen_question phrases with supplementary examples for all 11 MVP allergens", () => {
    for (const code of ALLERGEN_CODES) {
      const found = PHRASES.find((p) => p.purpose === "allergen_question" && p.allergen === code);
      expect(found, `missing allergen_question for ${code}`).toBeDefined();
      expect(found!.texts.ja).toContain("（");
      expect(found!.texts.en).toContain("(including");
    }

    // Specifically verify supplementary expressions for fish (fish broth / dashi)
    const fishPhrase = PHRASES.find((p) => p.purpose === "allergen_question" && p.allergen === "fish")!;
    expect(fishPhrase.texts.ja).toContain("魚介だし");
    expect(fishPhrase.texts.en).toContain("dashi");
  });

  it("includes all 4 staff answer options (contains, does not contain, cross-contact risk, unsure/checking)", () => {
    const answers = PHRASES.filter((p) => p.purpose === "staff_answer_option");
    expect(answers.map((a) => a.id)).toEqual([
      "ANS_CONTAINS",
      "ANS_DOES_NOT_CONTAIN",
      "ANS_CROSS_CONTACT_RISK",
      "ANS_UNSURE_OR_CHECKING",
    ]);
    expect(answers[0]!.texts.ja).toContain("入っています");
    expect(answers[1]!.texts.ja).toContain("入っていません");
    expect(answers[2]!.texts.ja).toContain("調理場・油で混ざる可能性があります");
    expect(answers[3]!.texts.ja).toContain("わかりません／確認します");
  });

  it("never contains forbidden safety verdict terms in any phrase text", () => {
    for (const phrase of PHRASES) {
      for (const text of Object.values(phrase.texts)) {
        expect(text).not.toMatch(/\b(safe|edible|allergen_absent)\b/i);
        expect(text).not.toMatch(/安全に食べられ|飲食可能/);
      }
    }
  });

  it("rejects duplicate phrase IDs or duplicate allergen_question entries in PhraseDatasetSchema", () => {
    const dupId = [PHRASES[0]!, { ...PHRASES[1]!, id: PHRASES[0]!.id }];
    expect(PhraseDatasetSchema.safeParse(dupId).success).toBe(false);

    const dupAllergen = [
      PHRASES[1]!,
      { ...PHRASES[1]!, id: "Q_ALLERGEN_SHRIMP_2" },
    ];
    expect(PhraseDatasetSchema.safeParse(dupAllergen).success).toBe(false);
  });
});

describe("PR4 Fail-Closed Phrase Resolution & Bundle Builder", () => {
  it("refuses to display a phrase if either storeLang or userLang verification is draft", () => {
    const sample = structuredClone(PHRASES[1]!) as Phrase;
    sample.verification.en = {
      level: "draft",
      methods: [],
      reviewedAt: null,
      reviewerRole: null,
      evidence: null,
      machineTranslationUsedForDraft: true,
    };

    expect(resolveBilingualPhrase(sample, "ja", "en")).toBeNull();
    expect(resolveBilingualPhrase(sample, "en", "ja")).toBeNull();

    const customPhrases = PHRASES.map((p) => (p.id === sample.id ? sample : p));
    const bundle = buildConfirmationCardBundle(
      { userLang: "ja", storeLang: "en", selectedAllergens: ["shrimp", "wheat"] },
      customPhrases,
    );

    expect(bundle.allergenQuestions.map((q) => q.allergen)).toEqual(["wheat"]);
    expect(bundle.unverifiedAllergens).toEqual(["shrimp"]);
  });

  it("fails closed on unsupported language pairs (never pretends unsupported pairs work)", () => {
    for (const [u, s] of [
      ["ja", "ja"],
      ["en", "en"],
      ["fr", "en"],
      ["ja", "ko"],
    ] as const) {
      const bundle = buildConfirmationCardBundle({
        userLang: u,
        storeLang: s,
        selectedAllergens: ["shrimp"],
      });
      expect(bundle.supportedPair).toBe(false);
      expect(bundle.noticePhrases).toHaveLength(0);
      expect(bundle.allergenQuestions).toHaveLength(0);
      expect(bundle.crossContactQuestions).toHaveLength(0);
      expect(bundle.staffAnswerOptions).toHaveLength(0);
      expect(bundle.unverifiedAllergens).toEqual(["shrimp"]);
    }
  });
});

describe("PR4 Confirmation Card UI — Bilingual Hierarchy, Verification Badges, AI Warnings & Ephemeral Staff Answers", () => {
  it("renders storeLang (en) as primary text and userLang (ja) as secondary reference for ja -> en", () => {
    const html = renderApp({
      initialStep: "confirmCard",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["shrimp", "fish"] },
    });

    // Standalone mode banner (no AI analysis used)
    expect(html).toContain('data-testid="card-standalone-mode-banner"');
    expect(html).toContain('data-card-mode="standalone"');
    expect(html).toContain('data-can-present="true"');

    // Team-reviewed provenance badge & 4-step UX workflow bar
    expect(html).toContain('data-testid="verified-card-header-badge"');
    expect(html).toContain("チーム内検証済み文言");
    expect(html).toContain('data-testid="card-ux-workflow-bar"');

    // Store language (en) appears BEFORE User language (ja) inside the card markup
    const storePos = html.indexOf('data-testid="phrase-store-text-Q_ALLERGEN_SHRIMP"');
    const userPos = html.indexOf('data-testid="phrase-user-text-Q_ALLERGEN_SHRIMP"');
    expect(storePos).toBeGreaterThan(0);
    expect(userPos).toBeGreaterThan(storePos);

    expect(html).toContain("Does this dish contain shrimp or prawns");
    expect(html).toContain("この料理に「えび」");

    expect(html).toContain('data-testid="phrase-store-text-Q_ALLERGEN_FISH"');
    expect(html).toContain("Does this dish contain fish or fish broth");
    expect(html).toContain("この料理に「魚・魚介だし等」");

    // Unselected allergens must not render allergen question cards
    expect(html).not.toContain('data-testid="phrase-card-Q_ALLERGEN_PEANUT"');

    // Cross-contact, frying oil, and broth questions are rendered
    expect(html).toContain('data-testid="phrase-card-Q_BROTH_SEASONING"');
    expect(html).toContain('data-testid="phrase-card-Q_CROSS_CONTACT"');
    expect(html).toContain('data-testid="phrase-card-Q_FRYING_OIL"');

    // All 4 staff answer options are rendered
    expect(html).toContain('data-testid="staff-answer-btn-ANS_CONTAINS"');
    expect(html).toContain('data-testid="staff-answer-btn-ANS_DOES_NOT_CONTAIN"');
    expect(html).toContain('data-testid="staff-answer-btn-ANS_CROSS_CONTACT_RISK"');
    expect(html).toContain('data-testid="staff-answer-btn-ANS_UNSURE_OR_CHECKING"');
    expect(html).toContain('data-testid="staff-answer-ephemeral-notice"');
  });

  it("reverses primary/secondary languages when userLang=en and storeLang=ja (English visitor in Japan)", () => {
    const htmlEn = renderApp({
      initialStep: "confirmCard",
      initialSettings: { userLang: "en", storeLang: "ja", allergens: ["buckwheat", "soy"] },
    });

    expect(htmlEn).toContain('data-testid="verified-card-header-badge"');
    expect(htmlEn).toContain("Team-Reviewed Phrases");

    // Primary store text is Japanese (lang="ja"), secondary user text is English (lang="en")
    const storePos = htmlEn.indexOf('lang="ja" data-testid="phrase-store-text-Q_ALLERGEN_BUCKWHEAT">この料理に「そば」');
    const userPos = htmlEn.indexOf(
      'lang="en" data-testid="phrase-user-text-Q_ALLERGEN_BUCKWHEAT">Does this dish contain buckwheat / soba',
    );
    expect(storePos).toBeGreaterThan(0);
    expect(userPos).toBeGreaterThan(storePos);
  });

  it("auto-generates verified confirmation card even when AI_DISABLED error occurred", () => {
    const aiDisabledErr = makeError("req-ai-disabled", "AI_DISABLED");
    const htmlErrorOnUpload = renderApp({
      initialStep: "upload",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["wheat", "milk"] },
      initialError: aiDisabledErr,
    });
    expect(htmlErrorOnUpload).toContain('data-error-code="AI_DISABLED"');
    expect(htmlErrorOnUpload).toContain('data-testid="error-card-fallback-btn"');

    // Proceeding to confirmCard after AI_DISABLED generates verified cards for wheat and milk
    const htmlCardAfterAiDisabled = renderApp({
      initialStep: "confirmCard",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["wheat", "milk"] },
    });
    expect(htmlCardAfterAiDisabled).toContain('data-card-mode="standalone"');
    expect(htmlCardAfterAiDisabled).toContain('data-can-present="true"');
    expect(htmlCardAfterAiDisabled).toContain('data-testid="phrase-card-Q_ALLERGEN_WHEAT"');
    expect(htmlCardAfterAiDisabled).toContain('data-testid="phrase-card-Q_ALLERGEN_MILK"');
  });

  it("displays strong AI unverified warnings and absence_claim warnings when navigated from AI analysis results", () => {
    const negationResponse = getProjectedFixture("negation_claims", ["peanut"]);
    const htmlWithAi = renderApp({
      initialStep: "confirmCard",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["peanut"] },
      initialResponse: negationResponse,
      initialSelectedDishIds: ["item-2"], // item-2 has absence_claim ("peanut-free")
    });

    expect(htmlWithAi).toContain('data-card-mode="with_analysis"');
    expect(htmlWithAi).toContain('data-testid="card-ai-dish-warning-banner"');
    expect(htmlWithAi).toContain("以下の料理名・判定はAIによる推測であり未確認（readBy: ai）です");
    expect(htmlWithAi).toContain('data-testid="card-dish-provenance-item-2"');
    expect(htmlWithAi).toContain("readBy: ai");
    expect(htmlWithAi).toContain('data-testid="card-dish-absence-warning-item-2"');
    expect(htmlWithAi).toContain("この記載は飲食可能・安全の保証ではありません");
  });

  it("highlights tapped staff answers ephemerally and never persists staff answers to localStorage", () => {
    const storageWrites: Array<{ key: string; value: string }> = [];
    const fakeWindow = {
      localStorage: {
        getItem: () => null,
        setItem: (key: string, value: string) => {
          storageWrites.push({ key, value });
        },
        removeItem: () => {},
      },
    };
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = fakeWindow;

    try {
      const htmlHighlighted = renderCard({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["egg"],
        targetItems: [],
        dataOrigin: null,
        hasAnalysisResult: false,
        messages: UI_MESSAGES.ja,
        initialSelectedAnswerIds: ["ANS_DOES_NOT_CONTAIN"],
        onBackToResults: () => {},
        onBackToUpload: () => {},
        onBackToSettings: () => {},
      });

      expect(htmlHighlighted).toContain('data-testid="staff-answer-btn-ANS_DOES_NOT_CONTAIN"');
      expect(htmlHighlighted).toContain('aria-pressed="true"');
      expect(htmlHighlighted).toContain('data-testid="staff-answer-selected-caution"');
      expect(htmlHighlighted).toContain('data-testid="clear-staff-answers-btn"');
      expect(storageWrites).toHaveLength(0);
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    }
  });

  it("never renders draft phrases in HTML and blocks staff presentation if a selected allergen only has a draft phrase", () => {
    const draftPeanutPhrase: Phrase = {
      id: "Q_ALLERGEN_PEANUT",
      purpose: "allergen_question",
      allergen: "peanut",
      texts: {
        ja: "【DRAFT絶対に表示しない】ピーナッツ質問",
        en: "[DRAFT NEVER SHOW] Does this dish contain peanuts?",
      },
      verification: {
        ja: {
          level: "draft",
          methods: [],
          reviewedAt: null,
          reviewerRole: null,
          evidence: null,
          machineTranslationUsedForDraft: true,
        },
        en: {
          level: "draft",
          methods: [],
          reviewedAt: null,
          reviewerRole: null,
          evidence: null,
          machineTranslationUsedForDraft: true,
        },
      },
    };

    const customPhrases = PHRASES.map((p) => (p.id === "Q_ALLERGEN_PEANUT" ? draftPeanutPhrase : p));
    const html = renderCard({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["peanut", "shrimp"],
      targetItems: [],
      dataOrigin: null,
      hasAnalysisResult: false,
      messages: UI_MESSAGES.ja,
      phrases: customPhrases,
      onBackToResults: () => {},
      onBackToUpload: () => {},
      onBackToSettings: () => {},
    });

    // Draft text must never appear in rendered HTML
    expect(html).not.toContain("DRAFT絶対に表示しない");
    expect(html).not.toContain("DRAFT NEVER SHOW");
    expect(html).not.toContain('data-testid="phrase-card-Q_ALLERGEN_PEANUT"');

    // Verified shrimp card is still rendered, fail-closed warning alerts about peanut, and staff presentation is blocked
    expect(html).toContain('data-testid="phrase-card-Q_ALLERGEN_SHRIMP"');
    expect(html).toContain('data-testid="card-unverified-allergens-warning"');
    expect(html).toContain('data-can-present="false"');
    expect(html).toContain('data-testid="card-presentation-blocked-banner"');
    expect(html).toContain(ALLERGENS.peanut.labels.ja);
  });
});

describe("PR4 Manual Editing UX, Single-Language Mismatch Warning, Restore & Safety Guards", () => {
  it("marks edited phrases as unverified, retains original verified phrase text on card, and never mutates PHRASES", () => {
    const originalShrimp = PHRASES.find((p) => p.id === "Q_ALLERGEN_SHRIMP")!;
    const snapshotBefore = structuredClone(originalShrimp);

    const htmlEdited = renderCard({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp"],
      targetItems: [],
      dataOrigin: null,
      hasAnalysisResult: false,
      messages: UI_MESSAGES.ja,
      initialPhraseEdits: {
        Q_ALLERGEN_SHRIMP: {
          storeText: "Does this dish or sauce contain any shrimp or shrimp broth?",
          userText: "この料理やソースにえびやえびだしは入っていますか？",
        },
      },
      onBackToResults: () => {},
      onBackToUpload: () => {},
      onBackToSettings: () => {},
    });

    // 1. Original PHRASES dataset is completely untouched
    expect(originalShrimp).toEqual(snapshotBefore);

    // 2. Edited card shows `user_edited_unverified` and never shows `phrase-verification-badge-Q_ALLERGEN_SHRIMP`
    expect(htmlEdited).toContain('data-testid="phrase-card-Q_ALLERGEN_SHRIMP"');
    expect(htmlEdited).toContain('data-verification-level="user_edited_unverified"');
    expect(htmlEdited).toContain('data-is-edited="true"');
    expect(htmlEdited).toContain('data-testid="phrase-edited-badge-Q_ALLERGEN_SHRIMP"');
    expect(htmlEdited).not.toContain('data-testid="phrase-verification-badge-Q_ALLERGEN_SHRIMP"');
    expect(htmlEdited).toContain('data-testid="card-edited-summary-banner"');

    // 3. Both edited texts are displayed AND original verified texts are retained in `phrase-original-verified-*`
    expect(htmlEdited).toContain("Does this dish or sauce contain any shrimp or shrimp broth?");
    expect(htmlEdited).toContain("この料理やソースにえびやえびだしは入っていますか？");
    expect(htmlEdited).toContain('data-testid="phrase-original-verified-Q_ALLERGEN_SHRIMP"');
    expect(htmlEdited).toContain(originalShrimp.texts.en);
    expect(htmlEdited).toContain(originalShrimp.texts.ja);

    // 4. Both languages were edited, so single-language mismatch warning is NOT shown
    expect(htmlEdited).not.toContain('data-testid="phrase-translation-mismatch-warning-Q_ALLERGEN_SHRIMP"');

    // 5. Restore Original buttons are rendered
    expect(htmlEdited).toContain('data-testid="reset-phrase-btn-Q_ALLERGEN_SHRIMP"');
    expect(htmlEdited).toContain('data-testid="reset-all-edits-btn"');

    // 6. Mandatory allergen badge and confirmationRequired badge remain locked on the edited card
    expect(htmlEdited).toContain('data-testid="phrase-allergen-tag-Q_ALLERGEN_SHRIMP"');
    expect(htmlEdited).toContain("店員への確認必須");
  });

  it("shows a translation mismatch warning when ONLY Japanese or ONLY English is edited", () => {
    const originalShrimp = PHRASES.find((p) => p.id === "Q_ALLERGEN_SHRIMP")!;

    // Case 1: Only userLang (ja) edited, storeLang (en) left unchanged
    const htmlOnlyJaEdited = renderCard({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp"],
      targetItems: [],
      dataOrigin: null,
      hasAnalysisResult: false,
      messages: UI_MESSAGES.ja,
      initialPhraseEdits: {
        Q_ALLERGEN_SHRIMP: {
          storeText: originalShrimp.texts.en!,
          userText: "【日本語側のみ手修正】桜えびやえびオイルも含めて入っていますか？",
        },
      },
      onBackToResults: () => {},
      onBackToUpload: () => {},
      onBackToSettings: () => {},
    });

    expect(htmlOnlyJaEdited).toContain('data-testid="phrase-translation-mismatch-warning-Q_ALLERGEN_SHRIMP"');
    expect(htmlOnlyJaEdited).toContain("片方の言語のみが編集されています");
    expect(htmlOnlyJaEdited).toContain("もう一方の言語は自動翻訳・自動更新されません");

    // Case 2: Only storeLang (en) edited, userLang (ja) left unchanged
    const htmlOnlyEnEdited = renderCard({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp"],
      targetItems: [],
      dataOrigin: null,
      hasAnalysisResult: false,
      messages: UI_MESSAGES.ja,
      initialPhraseEdits: {
        Q_ALLERGEN_SHRIMP: {
          storeText: "Does this dish contain any shrimp paste?",
          userText: originalShrimp.texts.ja!,
        },
      },
      onBackToResults: () => {},
      onBackToUpload: () => {},
      onBackToSettings: () => {},
    });

    expect(htmlOnlyEnEdited).toContain('data-testid="phrase-translation-mismatch-warning-Q_ALLERGEN_SHRIMP"');
  });

  it("restores verified state when an edit is reverted to the initial verified text", () => {
    const bundle = buildConfirmationCardBundle({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp"],
    });
    const shrimpPhrase = bundle.allergenQuestions[0]!;

    // Edited state -> user_edited_unverified
    const editedState = evaluatePhraseEditState(shrimpPhrase, {
      storeText: "Edited question?",
      userText: shrimpPhrase.userText,
    });
    expect(editedState.isEdited).toBe(true);
    expect(editedState.verificationStatus).toBe("user_edited_unverified");
    expect(editedState.hasSingleLangMismatch).toBe(true);

    // Restored state (undefined edit or matching original text) -> team_reviewed
    const restoredState = evaluatePhraseEditState(shrimpPhrase, undefined);
    expect(restoredState.isEdited).toBe(false);
    expect(restoredState.verificationStatus).toBe("team_reviewed");
    expect(restoredState.hasSingleLangMismatch).toBe(false);
    expect(restoredState.currentStoreText).toBe(shrimpPhrase.storeText);
    expect(restoredState.currentUserText).toBe(shrimpPhrase.userText);
  });

  it("generates a new session key whenever language pair, allergens, or target dishes change to reset edit state", () => {
    const baseKey = createCardEditSessionKey({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp", "wheat"],
      targetDishIds: ["item-1"],
    });

    // Reordering allergens or dish IDs keeps same session key
    expect(
      createCardEditSessionKey({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["wheat", "shrimp"],
        targetDishIds: ["item-1"],
      }),
    ).toBe(baseKey);

    // Changing language pair changes key
    expect(
      createCardEditSessionKey({
        userLang: "en",
        storeLang: "ja",
        selectedAllergens: ["shrimp", "wheat"],
        targetDishIds: ["item-1"],
      }),
    ).not.toBe(baseKey);

    // Changing selected allergens changes key
    expect(
      createCardEditSessionKey({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["shrimp", "egg"],
        targetDishIds: ["item-1"],
      }),
    ).not.toBe(baseKey);

    // Changing target dishes changes key
    expect(
      createCardEditSessionKey({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["shrimp", "wheat"],
        targetDishIds: ["item-2"],
      }),
    ).not.toBe(baseKey);
  });

  it("validates long text (<=300 chars), rejects empty/invisible-only strings, strips control chars, and escapes HTML", () => {
    // 1. Empty, whitespace-only, or zero-width invisible characters are rejected
    expect(validateEditedPhraseText("").valid).toBe(false);
    expect(validateEditedPhraseText("   \n\t  ").valid).toBe(false);
    expect(validateEditedPhraseText("\u200B\u2063\uFEFF").valid).toBe(false);
    expect(validateEditedPhraseText("\u3164\u2800").valid).toBe(false);

    // 2. Over 300 characters is rejected
    const over300 = "あ".repeat(MAX_EDITED_PHRASE_LENGTH + 1);
    const overRes = validateEditedPhraseText(over300);
    expect(overRes.valid).toBe(false);
    expect(overRes.reason).toBe("too_long");

    // Exactly 300 characters is accepted with overflow-wrap support
    const exact300 = "A".repeat(MAX_EDITED_PHRASE_LENGTH);
    expect(validateEditedPhraseText(exact300).valid).toBe(true);

    // 3. Control characters are stripped
    expect(sanitizeEditedPhraseInput("Hello\u0000\u0007World\nNext")).toBe("HelloWorld Next");

    // 4. HTML / script tags in edited text are safely escaped and never rendered as executable elements
    const xssAttempt = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const htmlWithXssAndInvalidEmpty = renderCard({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: ["shrimp"],
      targetItems: [],
      dataOrigin: null,
      hasAnalysisResult: false,
      messages: UI_MESSAGES.ja,
      initialEditingPhraseIds: ["Q_ALLERGEN_SHRIMP"],
      initialPhraseEdits: {
        Q_ALLERGEN_SHRIMP: {
          storeText: xssAttempt,
          userText: "\u200B\u2063", // invisible-only -> invalid!
        },
      },
      onBackToResults: () => {},
      onBackToUpload: () => {},
      onBackToSettings: () => {},
    });

    expect(htmlWithXssAndInvalidEmpty).not.toContain("<script>alert");
    expect(htmlWithXssAndInvalidEmpty).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    // Invalid empty/invisible userText triggers error and blocks staff presentation
    expect(htmlWithXssAndInvalidEmpty).toContain('data-testid="phrase-edit-invalid-warning-Q_ALLERGEN_SHRIMP"');
    expect(htmlWithXssAndInvalidEmpty).toContain('data-testid="edit-user-error-Q_ALLERGEN_SHRIMP"');
    expect(htmlWithXssAndInvalidEmpty).toContain('data-can-present="false"');
    expect(htmlWithXssAndInvalidEmpty).toContain('data-testid="card-presentation-blocked-banner"');
  });

  it("blocks staff presentation mode whenever mandatory safety notices cannot be shown", () => {
    const bundleNoAllergens = buildConfirmationCardBundle({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: [],
    });
    const readinessNoAllergens = evaluateCardPresentationReadiness({
      bundle: bundleNoAllergens,
      selectedAllergens: [],
      edits: {},
    });
    expect(readinessNoAllergens.canPresentToStaff).toBe(false);
    expect(readinessNoAllergens.blockingReasons).toContain("no_allergens_selected");

    // Even if initialPresentationMode=true is passed, it falls back to review_and_edit when blocked
    const htmlBlocked = renderCard({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: [],
      targetItems: [],
      dataOrigin: null,
      hasAnalysisResult: false,
      messages: UI_MESSAGES.ja,
      initialPresentationMode: true,
      onBackToResults: () => {},
      onBackToUpload: () => {},
      onBackToSettings: () => {},
    });
    expect(htmlBlocked).toContain('data-can-present="false"');
    expect(htmlBlocked).toContain('data-presentation-mode="review_and_edit"');
    expect(htmlBlocked).toContain('data-testid="card-presentation-blocked-banner"');
  });
});

describe("PR4 Error Screen & Standalone Card Fallback Path (Acceptance Criteria #9)", () => {
  it.each(ErrorCodeSchema.options)(
    "always offers both Retake/Retry and Standalone Confirmation Card buttons on error code %s in both ja and en",
    (code) => {
      for (const [userLang, storeLang] of [
        ["ja", "en"],
        ["en", "ja"],
      ] as const) {
        const err = makeError(`req-${code}-${userLang}`, code, code === "INVALID_INPUT" ? "image_too_large" : undefined);
        const html = renderApp({
          initialStep: "upload",
          initialSettings: { userLang, storeLang, allergens: ["shrimp"] },
          initialError: err,
        });

        expect(html).toContain('data-testid="error-banner"');
        expect(html).toContain(`data-error-code="${code}"`);
        expect(html).toContain('data-testid="error-retake-btn"');
        expect(html).toContain('data-testid="error-card-fallback-btn"');
        expect(html).toContain(UI_MESSAGES[userLang].errors.codeMessages[code]);
      }
    },
  );

  it.each(InvalidInputReasonSchema.options)(
    "displays localized cause-specific guidance for INVALID_INPUT reason %s in both ja and en",
    (reason) => {
      for (const [userLang, storeLang] of [
        ["ja", "en"],
        ["en", "ja"],
      ] as const) {
        const err = makeError(`req-${reason}-${userLang}`, "INVALID_INPUT", reason);
        const html = renderApp({
          initialStep: "upload",
          initialSettings: { userLang, storeLang, allergens: ["wheat"] },
          initialError: err,
        });

        expect(html).toContain(`data-error-reason="${reason}"`);
        expect(html).toContain('data-testid="error-reason-message"');
        expect(html).toContain(UI_MESSAGES[userLang].errors.invalidReasonMessages[reason]);
        expect(html).toContain('data-testid="error-retake-btn"');
        expect(html).toContain('data-testid="error-card-fallback-btn"');
      }
    },
  );
});
