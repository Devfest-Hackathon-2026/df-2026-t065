import { ALLERGEN_CODES, type AllergenCode } from "@/contracts/allergens";
import { hasVisibleContent, normalizeForMatch } from "@/contracts/analyze";
import type { VerificationLevel } from "@/contracts/phrases";
import type { BilingualDisplayPhrase, ConfirmationCardBundle } from "./phrases";

export const MAX_EDITED_PHRASE_LENGTH = 300;

export type EditablePhrasePurpose =
  | "allergen_question"
  | "broth_seasoning_question"
  | "cross_contact_question"
  | "frying_oil_question";

export const EDITABLE_PHRASE_PURPOSES: ReadonlySet<string> = new Set<EditablePhrasePurpose>([
  "allergen_question",
  "broth_seasoning_question",
  "cross_contact_question",
  "frying_oil_question",
]);

export function isEditablePhrasePurpose(purpose: string): purpose is EditablePhrasePurpose {
  return EDITABLE_PHRASE_PURPOSES.has(purpose);
}

export type PhraseEditEntry = {
  readonly storeText: string;
  readonly userText: string;
};

export type PhraseEditsMap = Readonly<Record<string, PhraseEditEntry>>;

export type EditValidationReason = "ok" | "empty_or_invisible" | "too_long";

export type EditValidationResult = {
  readonly valid: boolean;
  readonly reason: EditValidationReason;
  readonly sanitizedText: string;
  readonly charCount: number;
};

/**
 * Strips ASCII control characters (C0/C1) and normalizes line breaks to spaces
 * so user input remains single-paragraph plain text.
 * Never interprets HTML; React escapes JSX text nodes automatically.
 */
export function sanitizeEditedPhraseInput(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

/**
 * Validates an edited phrase text:
 * - Must contain visible characters (`hasVisibleContent` & `normalizeForMatch` non-empty).
 * - Must not exceed `MAX_EDITED_PHRASE_LENGTH` (300 chars).
 */
export function validateEditedPhraseText(raw: string): EditValidationResult {
  const sanitized = sanitizeEditedPhraseInput(raw);
  const trimmed = sanitized.trim();
  const charCount = [...trimmed].length;

  if (
    trimmed.length === 0 ||
    !hasVisibleContent(trimmed) ||
    normalizeForMatch(trimmed).length === 0
  ) {
    return {
      valid: false,
      reason: "empty_or_invisible",
      sanitizedText: sanitized,
      charCount: 0,
    };
  }

  if (charCount > MAX_EDITED_PHRASE_LENGTH || trimmed.length > MAX_EDITED_PHRASE_LENGTH) {
    return {
      valid: false,
      reason: "too_long",
      sanitizedText: sanitized,
      charCount,
    };
  }

  return {
    valid: true,
    reason: "ok",
    sanitizedText: trimmed,
    charCount,
  };
}

export type PhraseVerificationDisplayStatus = VerificationLevel | "user_edited_unverified";

/**
 * Immutable locked verified question for restaurant staff.
 * Can never be deleted, overwritten, or replaced by user manual edits.
 */
export type LockedVerifiedQuestion = {
  readonly id: string;
  readonly purpose: BilingualDisplayPhrase["purpose"];
  readonly allergen: AllergenCode | null;
  readonly storeText: string;
  readonly userText: string;
  readonly storeVerification: BilingualDisplayPhrase["storeVerification"];
  readonly userVerification: BilingualDisplayPhrase["userVerification"];
};

/**
 * Separate in-memory user free-form memo ("追加メモ") attached to a question card.
 * Completely isolated from `LockedVerifiedQuestion` in both data structure and UI.
 * Never claims app verification or automatic translation.
 */
export type EvaluatedUserMemo = {
  readonly isStoreEdited: boolean;
  readonly isUserEdited: boolean;
  readonly isEdited: boolean;
  /** Edited store-language memo text when `isStoreEdited` is true; otherwise `null` (never copies unedited locked text into the memo box). */
  readonly storeMemoText: string | null;
  /** Edited user-language memo text when `isUserEdited` is true; otherwise `null`. */
  readonly userMemoText: string | null;
  /** Current plain-text value inside the store-language editor textarea. */
  readonly draftStoreInput: string;
  /** Current plain-text value inside the user-language editor textarea. */
  readonly draftUserInput: string;
  /** True when only one language was edited while the other stayed at its initial text. */
  readonly hasSingleLangMismatch: boolean;
  readonly verificationStatus: "unedited" | "user_edited_unverified";
  readonly storeValidation: EditValidationResult;
  readonly userValidation: EditValidationResult;
  readonly isValid: boolean;
};

export type EvaluatedPhraseCard = {
  readonly original: BilingualDisplayPhrase;
  /** Locked, immutable verified question (always displayed as the primary staff-facing question). */
  readonly lockedQuestion: LockedVerifiedQuestion;
  /** Separate user-edited memo state (displayed only as an unverified supplemental memo, never replacing `lockedQuestion`). */
  readonly userMemo: EvaluatedUserMemo;
  /** Always locked to `original.storeText` so the primary staff question is never replaced. */
  readonly currentStoreText: string;
  /** Always locked to `original.userText` so the reference verified question is never replaced. */
  readonly currentUserText: string;
  /** Sanitized store-language memo text if edited (`isStoreEdited`), or `null` if unedited. */
  readonly editedStoreText: string | null;
  /** Sanitized user-language memo text if edited (`isUserEdited`), or `null` if unedited. */
  readonly editedUserText: string | null;
  readonly isStoreEdited: boolean;
  readonly isUserEdited: boolean;
  readonly isEdited: boolean;
  /** True when only one language was edited while the other stayed at its initial text. */
  readonly hasSingleLangMismatch: boolean;
  /** Never returns "team_reviewed" or "external_reviewed" when `isEdited` is true. */
  readonly verificationStatus: PhraseVerificationDisplayStatus;
  readonly storeValidation: EditValidationResult;
  readonly userValidation: EditValidationResult;
  readonly isValid: boolean;
};

/**
 * Evaluates a single phrase card against optional user edits in memory.
 * - `lockedQuestion` (`currentStoreText` / `currentUserText`) is permanently locked to the
 *   verified `BilingualDisplayPhrase` and can never be deleted or replaced.
 * - `userMemo` holds any user-entered supplemental memo separately and marks it `user_edited_unverified`.
 */
export function evaluatePhraseEditState(
  original: BilingualDisplayPhrase,
  edit?: PhraseEditEntry,
): EvaluatedPhraseCard {
  const lockedQuestion: LockedVerifiedQuestion = Object.freeze({
    id: original.id,
    purpose: original.purpose,
    allergen: original.allergen,
    storeText: original.storeText,
    userText: original.userText,
    storeVerification: original.storeVerification,
    userVerification: original.userVerification,
  });

  const rawStore = edit !== undefined ? edit.storeText : original.storeText;
  const rawUser = edit !== undefined ? edit.userText : original.userText;

  const sanitizedStore = sanitizeEditedPhraseInput(rawStore);
  const sanitizedUser = sanitizeEditedPhraseInput(rawUser);

  const storeValidation = validateEditedPhraseText(rawStore);
  const userValidation = validateEditedPhraseText(rawUser);

  const isStoreEdited = edit !== undefined && sanitizedStore.trim() !== original.storeText;
  const isUserEdited = edit !== undefined && sanitizedUser.trim() !== original.userText;
  const isEdited = isStoreEdited || isUserEdited;
  const hasSingleLangMismatch = (isStoreEdited && !isUserEdited) || (!isStoreEdited && isUserEdited);

  const storeMemoText = isStoreEdited ? sanitizedStore.trim() : null;
  const userMemoText = isUserEdited ? sanitizedUser.trim() : null;

  const userMemo: EvaluatedUserMemo = Object.freeze({
    isStoreEdited,
    isUserEdited,
    isEdited,
    storeMemoText,
    userMemoText,
    draftStoreInput: edit !== undefined ? sanitizedStore : original.storeText,
    draftUserInput: edit !== undefined ? sanitizedUser : original.userText,
    hasSingleLangMismatch,
    verificationStatus: isEdited ? "user_edited_unverified" : "unedited",
    storeValidation,
    userValidation,
    isValid: storeValidation.valid && userValidation.valid,
  });

  const verificationStatus: PhraseVerificationDisplayStatus = isEdited
    ? "user_edited_unverified"
    : original.storeVerification.level;

  const evaluated: EvaluatedPhraseCard = Object.freeze({
    original,
    lockedQuestion,
    userMemo,
    currentStoreText: lockedQuestion.storeText,
    currentUserText: lockedQuestion.userText,
    editedStoreText: storeMemoText,
    editedUserText: userMemoText,
    isStoreEdited,
    isUserEdited,
    isEdited,
    hasSingleLangMismatch,
    verificationStatus,
    storeValidation,
    userValidation,
    isValid: storeValidation.valid && userValidation.valid,
  });

  assertEvaluatedCardSafetyInvariants(evaluated);
  return evaluated;
}

/**
 * Runtime & test-time fail-closed invariant check ensuring that:
 * 1. Locked mandatory questions are never deleted, mutated, or replaced by user edits.
 * 2. User edits are isolated in `userMemo` and never marked as verified (`team_reviewed` / `external_reviewed`).
 * 3. Single-language edits never populate the unedited language slot in `userMemo`.
 */
export function assertEvaluatedCardSafetyInvariants(card: EvaluatedPhraseCard): void {
  if (
    !card.lockedQuestion ||
    card.lockedQuestion.storeText !== card.original.storeText ||
    card.lockedQuestion.userText !== card.original.userText ||
    card.currentStoreText !== card.original.storeText ||
    card.currentUserText !== card.original.userText
  ) {
    throw new Error(
      `Safety invariant violation on ${card.original.id}: locked verified question was modified or replaced.`,
    );
  }

  if (
    card.lockedQuestion.storeVerification.level === "draft" ||
    card.lockedQuestion.userVerification.level === "draft"
  ) {
    throw new Error(
      `Safety invariant violation on ${card.original.id}: draft phrase cannot be used as a locked verified question.`,
    );
  }

  if (card.isEdited) {
    if (
      card.verificationStatus !== "user_edited_unverified" ||
      card.userMemo.verificationStatus !== "user_edited_unverified"
    ) {
      throw new Error(
        `Safety invariant violation on ${card.original.id}: edited card must be marked user_edited_unverified.`,
      );
    }
  }

  if (!card.isStoreEdited && card.userMemo.storeMemoText !== null) {
    throw new Error(
      `Safety invariant violation on ${card.original.id}: unedited store language must be null in userMemo.`,
    );
  }

  if (!card.isUserEdited && card.userMemo.userMemoText !== null) {
    throw new Error(
      `Safety invariant violation on ${card.original.id}: unedited user language must be null in userMemo.`,
    );
  }
}

export type PresentationBlockingReason =
  | "unsupported_language_pair"
  | "no_allergens_selected"
  | "unverified_allergen_phrases"
  | "missing_mandatory_notice"
  | "missing_cross_contact_notices"
  | "invalid_edited_phrase";

export type CardPresentationReadiness = {
  readonly canPresentToStaff: boolean;
  readonly blockingReasons: readonly PresentationBlockingReason[];
  readonly hasAnyEdits: boolean;
  readonly hasAnySingleLangMismatch: boolean;
  readonly invalidPhraseIds: readonly string[];
};

/**
 * Determines whether the confirmation card can be safely presented to restaurant staff.
 * Fails closed (`canPresentToStaff: false`) if any mandatory safety notice (opening notice,
 * selected allergen questions, cross-contact/frying-oil/broth questions) cannot be displayed
 * or if any user edit is empty/invisible/over-length.
 */
export function evaluateCardPresentationReadiness(params: {
  bundle: ConfirmationCardBundle;
  selectedAllergens: readonly AllergenCode[];
  edits: PhraseEditsMap;
}): CardPresentationReadiness {
  const { bundle, selectedAllergens, edits } = params;
  const blockingReasons: PresentationBlockingReason[] = [];

  if (!bundle.supportedPair) {
    blockingReasons.push("unsupported_language_pair");
  }
  if (selectedAllergens.length === 0) {
    blockingReasons.push("no_allergens_selected");
  }
  if (bundle.unverifiedAllergens.length > 0 || bundle.allergenQuestions.length < selectedAllergens.length) {
    blockingReasons.push("unverified_allergen_phrases");
  }
  if (bundle.noticePhrases.length === 0) {
    blockingReasons.push("missing_mandatory_notice");
  }
  if (bundle.crossContactQuestions.length < 3) {
    blockingReasons.push("missing_cross_contact_notices");
  }

  const allEditableOriginals = [
    ...bundle.allergenQuestions,
    ...bundle.crossContactQuestions,
  ];

  let hasAnyEdits = false;
  let hasAnySingleLangMismatch = false;
  const invalidPhraseIds: string[] = [];

  for (const orig of allEditableOriginals) {
    const evaluated = evaluatePhraseEditState(orig, edits[orig.id]);
    if (evaluated.isEdited) {
      hasAnyEdits = true;
    }
    if (evaluated.hasSingleLangMismatch) {
      hasAnySingleLangMismatch = true;
    }
    if (!evaluated.isValid) {
      invalidPhraseIds.push(orig.id);
    }
  }

  if (invalidPhraseIds.length > 0) {
    blockingReasons.push("invalid_edited_phrase");
  }

  return {
    canPresentToStaff: blockingReasons.length === 0,
    blockingReasons,
    hasAnyEdits,
    hasAnySingleLangMismatch,
    invalidPhraseIds,
  };
}

/**
 * Computes a deterministic session key for the current confirmation card inputs.
 * When any input changes (language pair, selected allergens, or selected dish IDs),
 * the key changes and all in-memory manual edits are reset.
 */
export function createCardEditSessionKey(params: {
  userLang: string;
  storeLang: string;
  selectedAllergens: readonly AllergenCode[];
  targetDishIds: readonly string[];
}): string {
  const allergenSet = new Set(params.selectedAllergens);
  const canonicalAllergens = ALLERGEN_CODES.filter((c) => allergenSet.has(c)).join(",");
  const canonicalDishes = [...new Set(params.targetDishIds)].sort().join(",");
  return `${params.userLang}->${params.storeLang}|allergens:${canonicalAllergens}|dishes:${canonicalDishes}`;
}
