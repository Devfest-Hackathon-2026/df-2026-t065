import { z } from "zod";
import {
  DIETARY_CONDITION_CODES,
  DietaryPhraseSchema,
  type DietaryConditionCode,
  type DietaryPhrase,
} from "@/contracts/dietary";
import { isSupportedLanguagePair, SUPPORTED_LANGUAGE_PAIRS, type LanguagePair } from "@/contracts/analyze";
import type { VerificationRecord } from "@/contracts/phrases";
import rawDietaryPhrasesJson from "../../data/phrases/dietaryPhrases.json";

export const DietaryPhraseDatasetSchema = z
  .array(DietaryPhraseSchema)
  .min(1)
  .superRefine((phrases, ctx) => {
    const seenIds = new Set<string>();
    const seenConditionQuestions = new Set<DietaryConditionCode>();

    phrases.forEach((p, idx) => {
      if (seenIds.has(p.id)) {
        ctx.addIssue({
          code: "custom",
          path: [idx, "id"],
          message: `duplicate phrase id: ${p.id}`,
        });
      }
      seenIds.add(p.id);

      if ((p.purpose === "ingredient_question" || p.purpose === "process_question") && p.conditionCode !== null) {
        if (seenConditionQuestions.has(p.conditionCode)) {
          ctx.addIssue({
            code: "custom",
            path: [idx, "conditionCode"],
            message: `duplicate question for condition: ${p.conditionCode}`,
          });
        }
        seenConditionQuestions.add(p.conditionCode);
      }
    });
    const required = [
      "DIETARY_NOTICE_01", "DIETARY_ANS_YES", "DIETARY_ANS_NO", "DIETARY_ANS_UNKNOWN",
      ...DIETARY_CONDITION_CODES.map(code => `DIETARY_Q_${code.toUpperCase()}`),
    ];
    for (const id of required) {
      if (!seenIds.has(id)) ctx.addIssue({ code: "custom", message: `missing required phrase id: ${id}` });
    }

  });

export const DIETARY_PHRASES: readonly DietaryPhrase[] = Object.freeze(
  DietaryPhraseDatasetSchema.parse(rawDietaryPhrasesJson),
);

export type BilingualDietaryPhrase = {
  readonly id: string;
  readonly purpose: DietaryPhrase["purpose"];
  readonly conditionCode: DietaryConditionCode | null;
  readonly storeLang: string;
  readonly userLang: string;
  readonly storeText: string;
  readonly userText: string;
  readonly storeVerification: VerificationRecord;
  readonly userVerification: VerificationRecord;
};

export function isDietaryPhraseDisplayable(phrase: DietaryPhrase, lang: string): boolean {
  const record = phrase.verification[lang];
  return phrase.texts[lang] !== undefined && record !== undefined && record.level !== "draft";
}

export function resolveBilingualDietaryPhrase(
  phrase: DietaryPhrase,
  userLang: string,
  storeLang: string,
): BilingualDietaryPhrase | null {
  if (!isDietaryPhraseDisplayable(phrase, storeLang) || !isDietaryPhraseDisplayable(phrase, userLang)) {
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
    conditionCode: phrase.conditionCode,
    storeLang,
    userLang,
    storeText,
    userText,
    storeVerification,
    userVerification,
  };
}

export type DietaryConfirmationCardBundle = {
  readonly supportedPair: boolean;
  readonly userLang: string;
  readonly storeLang: string;
  readonly noticePhrases: readonly BilingualDietaryPhrase[];
  readonly conditionQuestions: readonly BilingualDietaryPhrase[];
  readonly unverifiedConditions: readonly DietaryConditionCode[];
  readonly staffAnswerOptions: readonly BilingualDietaryPhrase[];
};

export function buildDietaryConfirmationCardBundle(
  params: {
    userLang: string;
    storeLang: string;
    selectedConditions: readonly DietaryConditionCode[];
  },
  phrases: readonly DietaryPhrase[] = DIETARY_PHRASES,
  pairs: readonly LanguagePair[] = SUPPORTED_LANGUAGE_PAIRS,
): DietaryConfirmationCardBundle {
  const { userLang, storeLang, selectedConditions } = params;

  if (!isSupportedLanguagePair(userLang, storeLang, pairs)) {
    return {
      supportedPair: false,
      userLang,
      storeLang,
      noticePhrases: [],
      conditionQuestions: [],
      unverifiedConditions: [...selectedConditions],
      staffAnswerOptions: [],
    };
  }

  // Deduplicate in canonical DIETARY_CONDITION_CODES order
  const selectedSet = new Set(selectedConditions);
  const orderedSelected = DIETARY_CONDITION_CODES.filter((code) => selectedSet.has(code));

  const noticePhrases: BilingualDietaryPhrase[] = [];
  const staffAnswerOptions: BilingualDietaryPhrase[] = [];
  const questionMap = new Map<DietaryConditionCode, BilingualDietaryPhrase>();

  for (const phrase of phrases) {
    const resolved = resolveBilingualDietaryPhrase(phrase, userLang, storeLang);
    if (!resolved) continue;

    if (phrase.purpose === "dietary_notice") {
      noticePhrases.push(resolved);
    } else if (
      (phrase.purpose === "ingredient_question" || phrase.purpose === "process_question") &&
      phrase.conditionCode !== null
    ) {
      if (!questionMap.has(phrase.conditionCode)) {
        questionMap.set(phrase.conditionCode, resolved);
      }
    } else if (phrase.purpose === "staff_answer_option") {
      staffAnswerOptions.push(resolved);
    }
  }

  const conditionQuestions: BilingualDietaryPhrase[] = [];
  const unverifiedConditions: DietaryConditionCode[] = [];

  for (const code of orderedSelected) {
    const q = questionMap.get(code);
    if (q) {
      conditionQuestions.push(q);
    } else {
      unverifiedConditions.push(code);
    }
  }

  return {
    supportedPair: true,
    userLang,
    storeLang,
    noticePhrases,
    conditionQuestions,
    unverifiedConditions,
    staffAnswerOptions,
  };
}
