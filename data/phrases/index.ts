import { z } from "zod";
import { ALLERGEN_CODES, type AllergenCode } from "../../src/contracts/allergens";
import { isSupportedLanguagePair, SUPPORTED_LANGUAGE_PAIRS, type LanguagePair } from "../../src/contracts/analyze";
import {
  isDisplayable,
  PhraseSchema,
  type Phrase,
  type VerificationRecord,
} from "../../src/contracts/phrases";
import rawPhrasesJson from "./phrases.json";

export const PhraseDatasetSchema = z
  .array(PhraseSchema)
  .min(1)
  .superRefine((phrases, ctx) => {
    const seenIds = new Set<string>();
    const seenAllergenQuestions = new Set<AllergenCode>();

    phrases.forEach((p, idx) => {
      if (seenIds.has(p.id)) {
        ctx.addIssue({
          code: "custom",
          path: [idx, "id"],
          message: `duplicate phrase id: ${p.id}`,
        });
      }
      seenIds.add(p.id);

      if (p.purpose === "allergen_question" && p.allergen !== null) {
        if (seenAllergenQuestions.has(p.allergen)) {
          ctx.addIssue({
            code: "custom",
            path: [idx, "allergen"],
            message: `duplicate allergen_question for ${p.allergen}`,
          });
        }
        seenAllergenQuestions.add(p.allergen);
      }
    });
  });

/**
 * Validated static phrase dataset from `data/phrases/phrases.json`.
 * Throws at module initialization if any entry violates `PhraseSchema` or uniqueness rules.
 */
export const PHRASES: readonly Phrase[] = Object.freeze(PhraseDatasetSchema.parse(rawPhrasesJson));

export type BilingualDisplayPhrase = {
  readonly id: string;
  readonly purpose: Phrase["purpose"];
  readonly allergen: AllergenCode | null;
  readonly storeLang: string;
  readonly userLang: string;
  readonly storeText: string;
  readonly userText: string;
  readonly storeVerification: VerificationRecord;
  readonly userVerification: VerificationRecord;
};

/**
 * Resolves a Phrase into a displayable bilingual item ONLY when both `storeLang`
 * and `userLang` have non-draft verification records (`isDisplayable` === true).
 * Returns `null` if either language is missing or `draft` (fail-closed).
 */
export function resolveBilingualPhrase(
  phrase: Phrase,
  userLang: string,
  storeLang: string,
): BilingualDisplayPhrase | null {
  if (!isDisplayable(phrase, storeLang) || !isDisplayable(phrase, userLang)) {
    return null;
  }
  const storeText = phrase.texts[storeLang];
  const userText = phrase.texts[userLang];
  const storeVerification = phrase.verification[storeLang];
  const userVerification = phrase.verification[userLang];
  if (!storeText || !userText || !storeVerification || !userVerification) {
    return null;
  }
  if (storeVerification.level === "draft" || userVerification.level === "draft") {
    return null;
  }
  return {
    id: phrase.id,
    purpose: phrase.purpose,
    allergen: phrase.allergen,
    storeLang,
    userLang,
    storeText,
    userText,
    storeVerification,
    userVerification,
  };
}

export type ConfirmationCardBundle = {
  readonly supportedPair: boolean;
  readonly userLang: string;
  readonly storeLang: string;
  readonly noticePhrases: readonly BilingualDisplayPhrase[];
  readonly allergenQuestions: readonly BilingualDisplayPhrase[];
  readonly unverifiedAllergens: readonly AllergenCode[];
  readonly crossContactQuestions: readonly BilingualDisplayPhrase[];
  readonly staffAnswerOptions: readonly BilingualDisplayPhrase[];
};

const CROSS_CONTACT_PURPOSES: ReadonlySet<Phrase["purpose"]> = new Set([
  "broth_seasoning_question",
  "cross_contact_question",
  "frying_oil_question",
]);

/**
 * Builds the verified confirmation card bundle for the user's settings.
 * - Rejects unsupported language pairs (`supportedPair: false`).
 * - Never includes `draft` or unverified phrases.
 * - Tracks any selected allergen that lacks a verified displayable question in `unverifiedAllergens`
 *   so the UI can fail closed and warn rather than silently omitting an allergen.
 */
export function buildConfirmationCardBundle(
  params: {
    userLang: string;
    storeLang: string;
    selectedAllergens: readonly AllergenCode[];
  },
  phrases: readonly Phrase[] = PHRASES,
  pairs: readonly LanguagePair[] = SUPPORTED_LANGUAGE_PAIRS,
): ConfirmationCardBundle {
  const { userLang, storeLang, selectedAllergens } = params;

  if (!isSupportedLanguagePair(userLang, storeLang, pairs)) {
    return {
      supportedPair: false,
      userLang,
      storeLang,
      noticePhrases: [],
      allergenQuestions: [],
      unverifiedAllergens: [...selectedAllergens],
      crossContactQuestions: [],
      staffAnswerOptions: [],
    };
  }

  // Deduplicate selected allergens in canonical ALLERGEN_CODES order
  const selectedSet = new Set(selectedAllergens);
  const orderedSelected = ALLERGEN_CODES.filter((code) => selectedSet.has(code));

  const noticePhrases: BilingualDisplayPhrase[] = [];
  const crossContactQuestions: BilingualDisplayPhrase[] = [];
  const staffAnswerOptions: BilingualDisplayPhrase[] = [];
  const allergenQuestionMap = new Map<AllergenCode, BilingualDisplayPhrase>();

  for (const phrase of phrases) {
    const resolved = resolveBilingualPhrase(phrase, userLang, storeLang);
    if (!resolved) continue;

    if (phrase.purpose === "notice") {
      noticePhrases.push(resolved);
    } else if (phrase.purpose === "allergen_question" && phrase.allergen !== null) {
      if (!allergenQuestionMap.has(phrase.allergen)) {
        allergenQuestionMap.set(phrase.allergen, resolved);
      }
    } else if (CROSS_CONTACT_PURPOSES.has(phrase.purpose)) {
      crossContactQuestions.push(resolved);
    } else if (phrase.purpose === "staff_answer_option") {
      staffAnswerOptions.push(resolved);
    }
  }

  const allergenQuestions: BilingualDisplayPhrase[] = [];
  const unverifiedAllergens: AllergenCode[] = [];

  for (const code of orderedSelected) {
    const q = allergenQuestionMap.get(code);
    if (q) {
      allergenQuestions.push(q);
    } else {
      unverifiedAllergens.push(code);
    }
  }

  return {
    supportedPair: true,
    userLang,
    storeLang,
    noticePhrases,
    allergenQuestions,
    unverifiedAllergens,
    crossContactQuestions,
    staffAnswerOptions,
  };
}
