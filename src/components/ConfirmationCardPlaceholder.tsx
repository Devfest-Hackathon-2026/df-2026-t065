"use client";

import React, { useState } from "react";
import type { AllergenCode } from "@/contracts/allergens";
import type { AnalyzeMenuResponse, MenuItem } from "@/contracts/analyze";
import type { Phrase } from "@/contracts/phrases";
import {
  MAX_EDITED_PHRASE_LENGTH,
  createCardEditSessionKey,
  evaluateCardPresentationReadiness,
  evaluatePhraseEditState,
  isEditablePhrasePurpose,
  sanitizeEditedPhraseInput,
  type PhraseEditsMap,
} from "@/client/cardEditor";
import { getAllergenDualLabel, type UiMessages } from "@/client/i18n";
import {
  PHRASES,
  buildConfirmationCardBundle,
  type BilingualDisplayPhrase,
} from "@/client/phrases";
import { groupAssessmentsByCategory } from "@/client/resultOrganizer";
import { createStaffResponseContext } from "@/client/staffResponseStorage";
import { StaffResponseRecords } from "./StaffResponseRecords";
import styles from "./AllergyBridgeApp.module.css";

export type ConfirmationCardPlaceholderProps = {
  userLang: string;
  storeLang: string;
  selectedAllergens: readonly AllergenCode[];
  targetItems: readonly MenuItem[];
  dataOrigin: AnalyzeMenuResponse["dataOrigin"] | null;
  hasAnalysisResult: boolean;
  messages: UiMessages;
  phrases?: readonly Phrase[];
  initialSelectedAnswerIds?: readonly string[];
  initialPhraseEdits?: PhraseEditsMap;
  initialEditingPhraseIds?: readonly string[];
  initialPresentationMode?: boolean;
  onBackToResults: () => void;
  onBackToUpload: () => void;
  onBackToSettings: () => void;
};

export function ConfirmationCardPlaceholder({
  userLang,
  storeLang,
  selectedAllergens,
  targetItems,
  dataOrigin,
  hasAnalysisResult,
  messages,
  phrases = PHRASES,
  initialSelectedAnswerIds = [],
  initialPhraseEdits = {},
  initialEditingPhraseIds = [],
  initialPresentationMode = false,
  onBackToResults,
  onBackToUpload,
  onBackToSettings,
}: ConfirmationCardPlaceholderProps) {
  const c = messages.confirmCard;
  const r = messages.results;

  const targetDishIds = targetItems.map((item) => item.id);
  const currentSessionKey = createCardEditSessionKey({
    userLang,
    storeLang,
    selectedAllergens,
    targetDishIds,
  });

  // Track session key so any change to language pair, selected allergens, or target dishes immediately resets in-memory edits
  const [trackedSessionKey, setTrackedSessionKey] = useState<string>(currentSessionKey);
  const [phraseEdits, setPhraseEdits] = useState<PhraseEditsMap>(() => ({ ...initialPhraseEdits }));
  const [openEditorIds, setOpenEditorIds] = useState<string[]>(() => [...initialEditingPhraseIds]);
  const [isPresentationMode, setIsPresentationMode] = useState<boolean>(initialPresentationMode);

  // Ephemeral in-memory state ONLY for visual tap-highlighting during staff conversation (never persisted to localStorage)
  const [selectedAnswerIds, setSelectedAnswerIds] = useState<string[]>(() => [...initialSelectedAnswerIds]);

  if (trackedSessionKey !== currentSessionKey) {
    setTrackedSessionKey(currentSessionKey);
    setPhraseEdits({});
    setOpenEditorIds([]);
    setIsPresentationMode(false);
    setSelectedAnswerIds([]);
  }

  const effectiveEdits: PhraseEditsMap = trackedSessionKey === currentSessionKey ? phraseEdits : {};
  const effectiveOpenEditors: readonly string[] =
    trackedSessionKey === currentSessionKey ? openEditorIds : [];

  const userLabel = userLang === "ja" ? messages.settings.langBtnJa : messages.settings.langBtnEn;
  const storeLabel = storeLang === "ja" ? messages.settings.langBtnJa : messages.settings.langBtnEn;
  const pairDesc = `${userLabel} → ${storeLabel}`;

  const bundle = buildConfirmationCardBundle(
    {
      userLang,
      storeLang,
      selectedAllergens,
    },
    phrases,
  );

  const recordQuestions = [...bundle.allergenQuestions, ...bundle.crossContactQuestions];
  const responseContext = createStaffResponseContext({
    userLang, storeLang, selectedAllergens, targetItems, hasAnalysisResult, dataOrigin,
    edits: effectiveEdits, questions: recordQuestions,
  });

  const readiness = evaluateCardPresentationReadiness({
    bundle,
    selectedAllergens,
    edits: effectiveEdits,
  });

  const effectivePresentationMode =
    trackedSessionKey === currentSessionKey && isPresentationMode && readiness.canPresentToStaff;

  const toggleEditorOpen = (phraseId: string) => {
    setOpenEditorIds((prev) =>
      prev.includes(phraseId) ? prev.filter((id) => id !== phraseId) : [...prev, phraseId],
    );
  };

  const handleUpdatePhraseText = (
    phrase: BilingualDisplayPhrase,
    field: "storeText" | "userText",
    nextValue: string,
  ) => {
    const sanitized = sanitizeEditedPhraseInput(nextValue);
    setPhraseEdits((prev) => {
      const existing = prev[phrase.id] ?? {
        storeText: phrase.storeText,
        userText: phrase.userText,
      };
      const updated = {
        ...existing,
        [field]: sanitized,
      };
      // If both texts match the original verified text, remove the edit entry cleanly
      if (
        updated.storeText.trim() === phrase.storeText &&
        updated.userText.trim() === phrase.userText
      ) {
        const nextMap = { ...prev };
        delete nextMap[phrase.id];
        return nextMap;
      }
      return {
        ...prev,
        [phrase.id]: updated,
      };
    });
  };

  const handleResetSinglePhrase = (phraseId: string) => {
    setPhraseEdits((prev) => {
      if (!(phraseId in prev)) return prev;
      const nextMap = { ...prev };
      delete nextMap[phraseId];
      return nextMap;
    });
  };

  const handleResetAllEdits = () => {
    setPhraseEdits({});
    setOpenEditorIds([]);
  };

  const toggleStaffAnswer = (phraseId: string) => {
    if (!readiness.canPresentToStaff) return;
    setSelectedAnswerIds((prev) =>
      prev.includes(phraseId) ? prev.filter((id) => id !== phraseId) : [...prev, phraseId],
    );
  };

  const renderPhraseCard = (phrase: BilingualDisplayPhrase, isNotice = false) => {
    const editable = !isNotice && isEditablePhrasePurpose(phrase.purpose);
    const evaluated = evaluatePhraseEditState(phrase, editable ? effectiveEdits[phrase.id] : undefined);
    const isEditorOpen = editable && !effectivePresentationMode && effectiveOpenEditors.includes(phrase.id);

    const verifyTag = c.phraseVerificationTag(
      phrase.storeVerification.level,
      phrase.storeVerification.reviewedAt,
    );
    const allergenLabel =
      phrase.allergen !== null ? getAllergenDualLabel(phrase.allergen, userLang, storeLang) : null;

    return (
      <article
        key={phrase.id}
        className={`${styles.phraseCard} ${isNotice ? styles.phraseCardNotice : ""} ${
          evaluated.isEdited ? styles.phraseCardEdited : ""
        }`}
        data-testid={`phrase-card-${phrase.id}`}
        data-phrase-purpose={phrase.purpose}
        data-allergen={phrase.allergen ?? ""}
        data-verification-level={evaluated.verificationStatus}
        data-is-edited={String(evaluated.isEdited)}
      >
        {/* Locked Mandatory Safety Header (allergen label & confirmationRequired badge cannot be edited out) */}
        <div className={styles.phraseCardMetaRow}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span className={styles.storeLangTag}>{c.storeLangBadgeLabel(storeLang)}</span>
            {allergenLabel && (
              <span className={styles.confirmRequiredTag} data-testid={`phrase-allergen-tag-${phrase.id}`}>
                [!] {allergenLabel} — {r.confirmationRequiredBadge}
              </span>
            )}
            {!allergenLabel && !isNotice && (
              <span className={styles.confirmRequiredTag} data-testid={`phrase-confirm-tag-${phrase.id}`}>
                [!] {r.confirmationRequiredBadge}
              </span>
            )}
          </div>

          {!evaluated.isEdited ? (
            <span
              className={styles.verificationBadge}
              data-testid={`phrase-verification-badge-${phrase.id}`}
              title={phrase.storeVerification.evidence ?? undefined}
            >
              [✓] {verifyTag}
            </span>
          ) : (
            <span
              className={styles.editedBadge}
              data-testid={`phrase-edited-badge-${phrase.id}`}
            >
              [!] {c.editedUnverifiedBadge}
            </span>
          )}
        </div>

        {/* Locked Mandatory Verified Question (Can NEVER be deleted or replaced by user edits) */}
        <div data-testid={`phrase-locked-question-${phrase.id}`} data-locked-verified="true">
          {/* Primary large text in restaurant's language (storeLang) */}
          <p
            className={styles.phraseStoreText}
            style={{ overflowWrap: "anywhere" }}
            lang={storeLang}
            data-testid={`phrase-store-text-${phrase.id}`}
          >
            {evaluated.lockedQuestion.storeText}
          </p>

          {/* Secondary smaller reference text in user's language (userLang) */}
          <div className={styles.phraseUserRow}>
            <span className={styles.userLangTag}>{c.userLangBadgeLabel(userLang)}</span>
            <p
              className={styles.phraseUserText}
              style={{ overflowWrap: "anywhere" }}
              lang={userLang}
              data-testid={`phrase-user-text-${phrase.id}`}
            >
              {evaluated.lockedQuestion.userText}
            </p>
          </div>
        </div>

        {/* Separate User Free-Form Additional Memo Box (Unverified, Isolated from Locked Question) */}
        {evaluated.isEdited && (
          <div
            className={styles.originalVerifiedBox}
            role="note"
            data-testid={`phrase-user-memo-box-${phrase.id}`}
            data-verification-level="user_edited_unverified"
          >
            <p className={styles.originalVerifiedTitle}>[!] {c.userMemoBoxTitle}</p>
            <p
              className={styles.infoBoxBody}
              style={{ fontSize: "0.78rem", marginBottom: 6 }}
              data-testid={`phrase-user-memo-disclaimer-${phrase.id}`}
            >
              {c.userMemoDisclaimer}
            </p>
            {evaluated.userMemo.storeMemoText !== null ? (
              <div
                style={{ overflowWrap: "anywhere", marginBottom: 4 }}
                lang={storeLang}
                data-testid={`phrase-memo-store-text-${phrase.id}`}
              >
                <strong>{storeLang.toUpperCase()}:</strong> {evaluated.userMemo.storeMemoText}
              </div>
            ) : (
              <div
                style={{ fontSize: "0.8rem", opacity: 0.85, marginBottom: 4 }}
                data-testid={`phrase-memo-store-untranslated-${phrase.id}`}
              >
                {c.userMemoStoreLangUntranslated}
              </div>
            )}
            {evaluated.userMemo.userMemoText !== null ? (
              <div
                style={{ overflowWrap: "anywhere" }}
                lang={userLang}
                data-testid={`phrase-memo-user-text-${phrase.id}`}
              >
                <strong>{userLang.toUpperCase()}:</strong> {evaluated.userMemo.userMemoText}
              </div>
            ) : (
              <div
                style={{ fontSize: "0.8rem", opacity: 0.85 }}
                data-testid={`phrase-memo-user-untranslated-${phrase.id}`}
              >
                {c.userMemoUserLangUntranslated}
              </div>
            )}
          </div>
        )}

        {/* Single-Language Edit Mismatch Warning (when only storeLang or only userLang was modified) */}
        {evaluated.hasSingleLangMismatch && (
          <div
            className={styles.mismatchWarningBox}
            role="alert"
            data-testid={`phrase-translation-mismatch-warning-${phrase.id}`}
          >
            <p className={styles.mismatchWarningTitle}>[!] {c.singleLangMismatchWarningTitle}</p>
            <p className={styles.mismatchWarningBody}>{c.singleLangMismatchWarningBody}</p>
          </div>
        )}

        {/* Validation Error Warning if edited text is empty/invisible or exceeds 300 chars */}
        {!evaluated.isValid && (
          <div
            className={styles.absenceWarningBox}
            role="alert"
            data-testid={`phrase-edit-invalid-warning-${phrase.id}`}
          >
            {!evaluated.storeValidation.valid && (
              <p id={`edit-store-error-${phrase.id}`} className={styles.editErrorText} data-testid={`edit-store-error-${phrase.id}`}>
                {evaluated.storeValidation.reason === "empty_or_invisible"
                  ? c.editInvalidEmptyError
                  : c.editInvalidLengthError(MAX_EDITED_PHRASE_LENGTH)}
              </p>
            )}
            {!evaluated.userValidation.valid && (
              <p id={`edit-user-error-${phrase.id}`} className={styles.editErrorText} data-testid={`edit-user-error-${phrase.id}`}>
                {evaluated.userValidation.reason === "empty_or_invisible"
                  ? c.editInvalidEmptyError
                  : c.editInvalidLengthError(MAX_EDITED_PHRASE_LENGTH)}
              </p>
            )}
          </div>
        )}

        {/* Original Verified Phrase Box (Always retained and shown whenever edited) */}
        {evaluated.isEdited && (
          <div
            className={styles.originalVerifiedBox}
            role="note"
            data-testid={`phrase-original-verified-${phrase.id}`}
          >
            <p className={styles.originalVerifiedTitle}>[✓] {c.originalVerifiedReferenceTitle}</p>
            <div lang={storeLang} data-testid={`phrase-original-store-text-${phrase.id}`}>
              <strong>{storeLang.toUpperCase()}:</strong> {phrase.storeText}
            </div>
            <div lang={userLang} data-testid={`phrase-original-user-text-${phrase.id}`}>
              <strong>{userLang.toUpperCase()}:</strong> {phrase.userText}
            </div>
          </div>
        )}

        {/* Edit & Restore Controls (hidden in Staff Presentation View unless invalid) */}
        {editable && (!effectivePresentationMode || evaluated.isEdited) && (
          <div className={styles.editControlsRow}>
            {!effectivePresentationMode && (
              <button
                type="button"
                aria-expanded={isEditorOpen}
                onClick={() => toggleEditorOpen(phrase.id)}
                className={styles.smallBtn}
                data-testid={`edit-phrase-btn-${phrase.id}`}
              >
                {isEditorOpen ? c.closeEditPhraseBtn : c.editPhraseBtn}
              </button>
            )}
            {evaluated.isEdited && (
              <button
                type="button"
                onClick={() => handleResetSinglePhrase(phrase.id)}
                className={styles.smallBtn}
                data-testid={`reset-phrase-btn-${phrase.id}`}
              >
                {c.resetPhraseBtn}
              </button>
            )}
          </div>
        )}

        {/* Inline Plain-Text Editor (In-Memory Only, No HTML Execution) */}
        {isEditorOpen && (
          <div className={styles.editEditorBox} data-testid={`phrase-editor-box-${phrase.id}`}>
            <div className={styles.editFieldGroup}>
              <label
                htmlFor={`edit-store-${phrase.id}`}
                className={styles.fieldLabel}
                style={{ fontSize: "0.86rem" }}
              >
                {c.editStoreLangInputLabel(storeLang)}
              </label>
              <textarea
                id={`edit-store-${phrase.id}`}
                aria-invalid={!evaluated.storeValidation.valid}
                aria-describedby={`edit-store-count-${phrase.id} edit-hint-${phrase.id}${!evaluated.storeValidation.valid ? ` edit-store-error-${phrase.id}` : ""}`}
                value={evaluated.userMemo.draftStoreInput}
                onChange={(e) => handleUpdatePhraseText(phrase, "storeText", e.target.value)}
                rows={2}
                className={`${styles.editTextarea} ${
                  !evaluated.storeValidation.valid ? styles.editTextareaInvalid : ""
                }`}
                data-testid={`edit-store-textarea-${phrase.id}`}
              />
              <div id={`edit-store-count-${phrase.id}`} className={styles.editCharCount} data-testid={`edit-store-char-count-${phrase.id}`}>
                {[...evaluated.userMemo.draftStoreInput.trim()].length} / {MAX_EDITED_PHRASE_LENGTH}
              </div>
            </div>

            <div className={styles.editFieldGroup}>
              <label
                htmlFor={`edit-user-${phrase.id}`}
                className={styles.fieldLabel}
                style={{ fontSize: "0.86rem" }}
              >
                {c.editUserLangInputLabel(userLang)}
              </label>
              <textarea
                id={`edit-user-${phrase.id}`}
                aria-invalid={!evaluated.userValidation.valid}
                aria-describedby={`edit-user-count-${phrase.id} edit-hint-${phrase.id}${!evaluated.userValidation.valid ? ` edit-user-error-${phrase.id}` : ""}`}
                value={evaluated.userMemo.draftUserInput}
                onChange={(e) => handleUpdatePhraseText(phrase, "userText", e.target.value)}
                rows={2}
                className={`${styles.editTextarea} ${
                  !evaluated.userValidation.valid ? styles.editTextareaInvalid : ""
                }`}
                data-testid={`edit-user-textarea-${phrase.id}`}
              />
              <div id={`edit-user-count-${phrase.id}`} className={styles.editCharCount} data-testid={`edit-user-char-count-${phrase.id}`}>
                {[...evaluated.userMemo.draftUserInput.trim()].length} / {MAX_EDITED_PHRASE_LENGTH}
              </div>
            </div>

            <p id={`edit-hint-${phrase.id}`} className={styles.infoBoxBody} style={{ fontSize: "0.78rem" }}>
              {c.editNoAutoTranslationHint}
            </p>
          </div>
        )}
      </article>
    );
  };

  return (
    <section
      className={styles.sectionCard}
      aria-labelledby="confirm-card-section-title"
      data-testid="confirm-card-placeholder-section"
      data-card-mode={hasAnalysisResult ? "with_analysis" : "standalone"}
      data-presentation-mode={effectivePresentationMode ? "staff_presentation" : "review_and_edit"}
      data-can-present={String(readiness.canPresentToStaff)}
      data-origin={dataOrigin ?? "none"}
    >
      <h2 id="confirm-card-section-title" className={styles.sectionTitle} tabIndex={-1}>
        {c.sectionTitle}
      </h2>
      <p className={styles.sectionHelp}>{c.showToStaffGuide}</p>

      {/* 4-Step UX Workflow Indicator: Auto-generate -> Review Bilingual -> Edit if needed -> Present to Staff */}
      <div
        className={styles.uxWorkflowBar}
        role="region"
        aria-label={c.uxWorkflowLabel}
        data-testid="card-ux-workflow-bar"
      >
        {c.uxWorkflowSteps.map((stepText, idx) => (
          <div key={idx} className={styles.uxWorkflowStep}>
            {stepText}
          </div>
        ))}
      </div>

      {/* Mode Switcher (Review/Edit <-> Staff Presentation) & Global Restore All Edits */}
      <div className={styles.uxControlRow}>
        <button
          type="button"
          disabled={!readiness.canPresentToStaff}
          aria-pressed={effectivePresentationMode}
          onClick={() => {
            if (readiness.canPresentToStaff) {
              setIsPresentationMode((prev) => !prev);
            }
          }}
          className={effectivePresentationMode ? styles.secondaryBtn : styles.primaryBtn}
          data-testid="toggle-staff-presentation-btn"
        >
          {effectivePresentationMode ? c.modeToggleToReviewBtn : c.modeToggleToPresentBtn}
        </button>

        {readiness.hasAnyEdits && (
          <button
            type="button"
            onClick={handleResetAllEdits}
            className={styles.secondaryBtn}
            data-testid="reset-all-edits-btn"
          >
            {c.resetAllEditsBtn}
          </button>
        )}
      </div>

      {effectivePresentationMode && (
        <div
          className={styles.infoBox}
          role="status"
          data-testid="staff-presentation-active-banner"
        >
          <p className={styles.infoBoxBody} style={{ fontWeight: 700 }}>
            {c.presentationModeActiveBanner}
          </p>
        </div>
      )}

      {/* Mandatory Mock Banner when navigated from a mock_fixture analysis */}
      {dataOrigin === "mock_fixture" && (
        <div className={styles.mockBanner} role="note" data-testid="card-mock-banner">
          <p className={styles.mockBannerTitle}>{r.mockDataBannerTitle}</p>
          <p className={styles.mockBannerBody}>{r.mockDataBannerBody}</p>
        </div>
      )}

      {/* Standalone Mode Banner when used without AI or via Error Fallback */}
      {!hasAnalysisResult && (
        <div className={styles.infoBox} role="status" data-testid="card-standalone-mode-banner">
          <p className={styles.infoBoxTitle}>{c.standaloneModeTitle}</p>
          <p className={styles.infoBoxBody}>{c.standaloneModeBody}</p>
        </div>
      )}

      {/* Team-Reviewed Verification Provenance Banner */}
      <div
        className={styles.verifiedHeaderBanner}
        role="note"
        data-testid="verified-card-header-badge"
      >
        <p className={styles.verifiedHeaderTitle}>[✓] {c.verifiedBadgeTitle}</p>
        <p className={styles.verifiedHeaderBody}>{c.verifiedBadgeBody}</p>
      </div>

      {/* Summary Banner when Manual Edits are Active */}
      {readiness.hasAnyEdits && (
        <div
          className={styles.infoBoxWarning}
          role="status"
          data-testid="card-edited-summary-banner"
        >
          <p className={styles.infoBoxBody} style={{ fontWeight: 700 }}>
            [!] {c.editedCardSummaryBanner}
          </p>
        </div>
      )}

      {/* Fail-closed alerts when mandatory notices cannot be displayed or presentation is blocked */}
      {!readiness.canPresentToStaff && (
        <div
          className={styles.errorCard}
          role="alert"
          data-testid="card-presentation-blocked-banner"
          data-blocking-reasons={readiness.blockingReasons.join(",")}
        >
          <p className={styles.errorTitle}>[!] {c.presentationBlockedTitle}</p>
          <p className={styles.errorBody}>{c.presentationBlockedBody}</p>
        </div>
      )}

      {!bundle.supportedPair && (
        <div className={styles.errorCard} role="alert" data-testid="card-unsupported-pair-warning">
          <p className={styles.errorTitle}>[!] {c.unsupportedPairTitle}</p>
          <p className={styles.errorBody}>{c.unsupportedPairBody}</p>
        </div>
      )}

      {bundle.supportedPair && selectedAllergens.length === 0 && (
        <div className={styles.infoBoxWarning} role="alert" data-testid="card-no-allergens-warning">
          <p className={styles.infoBoxTitle}>[!] {c.noAllergensTitle}</p>
          <p className={styles.infoBoxBody}>{c.noAllergensBody}</p>
        </div>
      )}

      {bundle.supportedPair && bundle.unverifiedAllergens.length > 0 && (
        <div className={styles.errorCard} role="alert" data-testid="card-unverified-allergens-warning">
          <p className={styles.errorTitle}>[!] {c.unverifiedAllergensTitle}</p>
          <p className={styles.errorBody}>
            {c.unverifiedAllergensBody} (
            {bundle.unverifiedAllergens
              .map((code) => getAllergenDualLabel(code, userLang, storeLang))
              .join(", ")}
            )
          </p>
        </div>
      )}

      {/* 1. Opening Allergy Notice Card (Locked Mandatory Notice) */}
      {bundle.noticePhrases.length > 0 && (
        <div className={styles.cardGroupBlock} data-testid="card-notice-group">
          <h3 className={styles.cardGroupTitle}>{c.noticeSectionTitle}</h3>
          {bundle.noticePhrases.map((phrase) => renderPhraseCard(phrase, true))}
        </div>
      )}

      {/* 2. Allergen-Specific Question Cards */}
      {bundle.allergenQuestions.length > 0 && (
        <div className={styles.cardGroupBlock} data-testid="card-allergen-questions-group">
          <h3 className={styles.cardGroupTitle}>{c.allergenQuestionsTitle}</h3>
          {bundle.allergenQuestions.map((phrase) => renderPhraseCard(phrase, false))}
        </div>
      )}

      {/* 3. Broth/Seasonings, Cross-Contact, and Frying Oil Question Cards */}
      {bundle.crossContactQuestions.length > 0 && (
        <div className={styles.cardGroupBlock} data-testid="card-cross-contact-questions-group">
          <h3 className={styles.cardGroupTitle}>{c.crossContactQuestionsTitle}</h3>
          {bundle.crossContactQuestions.map((phrase) => renderPhraseCard(phrase, false))}
        </div>
      )}

      {/* 4. Interactive Point-and-Tap Staff Answer Options (4 Choices, Ephemeral Only) */}
      {bundle.staffAnswerOptions.length > 0 && (
        <div className={styles.cardGroupBlock} data-testid="card-staff-answers-group">
          <div className={styles.allergenHeaderRow}>
            <h3 className={styles.cardGroupTitle} style={{ borderBottom: "none", marginBottom: 0 }}>
              {c.staffAnswerSectionTitle}
            </h3>
            {selectedAnswerIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedAnswerIds([])}
                className={styles.smallBtn}
                data-testid="clear-staff-answers-btn"
              >
                {c.clearStaffAnswerSelectionBtn}
              </button>
            )}
          </div>
          <p className={styles.fieldHelp}>{c.staffAnswerSectionHelp}</p>

          <div className={styles.staffAnswerGrid} role="group" aria-label={c.staffAnswerSectionTitle}>
            {bundle.staffAnswerOptions.map((opt) => {
              const isSelected = selectedAnswerIds.includes(opt.id);
              const verifyTag = c.phraseVerificationTag(
                opt.storeVerification.level,
                opt.storeVerification.reviewedAt,
              );

              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={!readiness.canPresentToStaff}
                  aria-pressed={isSelected}
                  onClick={() => toggleStaffAnswer(opt.id)}
                  className={`${styles.staffAnswerBtn} ${isSelected ? styles.staffAnswerBtnSelected : ""}`}
                  data-testid={`staff-answer-btn-${opt.id}`}
                  data-verification-level={opt.storeVerification.level}
                >
                  <div style={{ width: "100%" }}>
                    <div className={styles.phraseCardMetaRow}>
                      <span className={styles.storeLangTag}>{c.storeLangBadgeLabel(storeLang)}</span>
                      <span className={styles.verificationBadge}>[✓] {verifyTag}</span>
                    </div>
                    <p
                      className={styles.staffAnswerStoreText}
                      lang={storeLang}
                      data-testid={`staff-answer-store-text-${opt.id}`}
                    >
                      {opt.storeText}
                    </p>
                  </div>
                  <p
                    className={styles.staffAnswerUserText}
                    lang={userLang}
                    data-testid={`staff-answer-user-text-${opt.id}`}
                  >
                    {opt.userText}
                  </p>
                </button>
              );
            })}
          </div>

          {selectedAnswerIds.length > 0 && (
            <div
              className={styles.infoBoxWarning}
              style={{ marginTop: 12, marginBottom: 0 }}
              role="note"
              data-testid="staff-answer-selected-caution"
            >
              <p className={styles.infoBoxBody} style={{ fontWeight: 700 }}>
                {c.staffAnswerSelectedCaution}
              </p>
            </div>
          )}

          <div
            className={styles.ephemeralNoticeBox}
            role="note"
            data-testid="staff-answer-ephemeral-notice"
          >
            {c.staffAnswerEphemeralNotice}
          </div>
        </div>
      )}

      <StaffResponseRecords key={responseContext} context={responseContext}
        questions={recordQuestions} userLang={userLang} storeLang={storeLang}
        enabled={readiness.canPresentToStaff} />

      {/* 5. Carried-Over Context Summary & AI-Read Target Dishes (with Strong Unverified AI Warnings) */}
      <div className={styles.infoBox} data-testid="confirm-card-context-summary">
        <h3 className={styles.infoBoxTitle}>{c.summaryTitle}</h3>

        <div style={{ marginTop: 10 }}>
          <strong className={styles.fieldLabel}>{c.languagePairSummary}</strong>
          <p className={styles.infoBoxBody} data-testid="card-summary-language-pair">
            {pairDesc} ({userLang} → {storeLang})
          </p>
        </div>

        <div style={{ marginTop: 12 }}>
          <strong className={styles.fieldLabel}>{c.selectedAllergensSummary}</strong>
          {selectedAllergens.length === 0 ? (
            <p className={styles.infoBoxBody}>{c.noAllergensBody}</p>
          ) : (
            <ul className={styles.summaryList} data-testid="card-summary-allergens">
              {selectedAllergens.map((code) => (
                <li key={code} data-testid={`card-summary-allergen-${code}`}>
                  <strong>{getAllergenDualLabel(code, userLang, storeLang)}</strong> —{" "}
                  <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <strong className={styles.fieldLabel}>{c.targetDishesSummary}</strong>
          {targetItems.length === 0 ? (
            <p className={styles.infoBoxBody} data-testid="card-summary-no-dishes">
              {c.noSpecificDishesSelected}
            </p>
          ) : (
            <div>
              {/* Strong AI Warning Banner when target dishes from AI reading are shown */}
              <div
                className={styles.aiDishWarningBanner}
                role="note"
                data-testid="card-ai-dish-warning-banner"
              >
                <p className={styles.aiDishWarningTitle}>[!] {c.aiDishStrongWarningTitle}</p>
                <p className={styles.aiDishWarningBody}>{c.aiDishStrongWarningBody}</p>
              </div>

              <ul className={styles.summaryList} data-testid="card-summary-dishes">
                {targetItems.map((item) => {
                  const grouped = groupAssessmentsByCategory(item.allergens);
                  return (
                    <li
                      key={item.id}
                      style={{ marginBottom: 12 }}
                      data-testid={`card-summary-dish-${item.id}`}
                      data-read-by={item.readText.readBy}
                      data-translation-verified={
                        item.aiTranslation ? String(item.aiTranslation.verified) : "none"
                      }
                      data-origin={dataOrigin ?? "none"}
                    >
                      <div
                        className={styles.readTextLabel}
                        data-testid={`card-dish-provenance-${item.id}`}
                      >
                        [AI] {r.aiMisreadWarning} (readBy: {item.readText.readBy})
                        {item.aiTranslation
                          ? ` / ${r.unverifiedTranslationBadge} (verified: false)`
                          : ""}
                        {dataOrigin === "mock_fixture" ? " / [mock_fixture]" : ""}
                      </div>
                      <div style={{ overflowWrap: "anywhere" }}>
                        <strong>{item.readText.text}</strong> —{" "}
                        <span className={styles.confirmRequiredTag}>
                          {r.confirmationRequiredBadge}
                        </span>
                      </div>
                      {item.aiTranslation && (
                        <div className={styles.translationRow} style={{ overflowWrap: "anywhere" }}>
                          <span className={styles.readTextLabel} style={{ marginRight: 6 }}>
                            {r.unverifiedTranslationBadge}
                          </span>
                          <span>{item.aiTranslation.text}</span>
                        </div>
                      )}

                      {/* Dish Allergen Category Summary (never a safety verdict) */}
                      <div className={styles.badgeRow} data-testid={`card-dish-assessments-${item.id}`}>
                        {grouped.menu_mentions.map((a) => (
                          <span key={a.code} className={styles.mentionKindTag}>
                            [!] {getAllergenDualLabel(a.code, userLang, storeLang)}:{" "}
                            {r.categoryBadges.menu_mentions} ({r.mentionKindBadges[a.mention.kind]})
                          </span>
                        ))}
                        {grouped.ai_inferred.map((a) => (
                          <span key={a.code} className={styles.metaBadge}>
                            [?] {getAllergenDualLabel(a.code, userLang, storeLang)}:{" "}
                            {r.categoryBadges.ai_inferred}
                          </span>
                        ))}
                        {grouped.unconfirmed.map((a) => (
                          <span key={a.code} className={styles.metaBadge}>
                            [未確認 / UNCONFIRMED]{" "}
                            {getAllergenDualLabel(a.code, userLang, storeLang)}:{" "}
                            {r.categoryBadges.unconfirmed}
                          </span>
                        ))}
                      </div>
                      {grouped.menu_mentions.some((a) => a.mention.kind === "absence_claim") && (
                        <div
                          className={styles.absenceWarningBox}
                          role="note"
                          data-testid={`card-dish-absence-warning-${item.id}`}
                        >
                          {r.absenceClaimWarning}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Key Checklist to Confirm with Staff (Locked Mandatory Safety Checklist) */}
      <div className={styles.infoBoxWarning} role="note" data-testid="card-mandatory-checklist">
        <h3 className={styles.infoBoxTitle}>{c.alwaysConfirmChecklistTitle}</h3>
        <ul className={styles.summaryList}>
          {c.alwaysConfirmChecklist.map((point, idx) => (
            <li key={idx}>{point}</li>
          ))}
        </ul>
      </div>

      {/* Navigation */}
      <div className={styles.actionRow}>
        {hasAnalysisResult && (
          <button
            type="button"
            onClick={onBackToResults}
            className={styles.primaryBtn}
            data-testid="card-back-to-results-btn"
          >
            {c.backToResultsBtn}
          </button>
        )}
        <button
          type="button"
          onClick={onBackToUpload}
          className={styles.secondaryBtn}
          data-testid="card-back-to-upload-btn"
        >
          {c.backToUploadBtn}
        </button>
        <button
          type="button"
          onClick={onBackToSettings}
          className={styles.secondaryBtn}
          data-testid="card-back-to-settings-btn"
        >
          {c.backToSettingsBtn}
        </button>
      </div>
    </section>
  );
}

export { ConfirmationCardPlaceholder as ConfirmationCardSection };
