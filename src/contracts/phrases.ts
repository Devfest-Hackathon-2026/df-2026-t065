import { z } from "zod";
import { AllergenCodeSchema } from "./allergens";
import { LanguageTagSchema } from "./analyze";

/*
 * Confirmation-card phrase contract.
 *
 * Cards are shown to restaurant staff in the store language. A phrase text may
 * be displayed only if its translation check is recorded here. Machine
 * translation (including Gemini) may be used for a draft, but is never a
 * verification method. The phrase data itself is added in PR4.
 */

export const VerificationLevelSchema = z.enum([
  "external_reviewed", // reviewed by a native / highly proficient external reviewer
  "team_reviewed", // checked within the team (back-translation etc.); UI must label it
  "draft", // never displayed
]);
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;

export const VerificationMethodSchema = z.enum([
  "back_translation", // a member who did not write it translates back and compares meaning
  "official_term_check", // allergen terms compared with an official source (cited in evidence)
  "bilingual_member_review",
  "native_speaker_review",
]);

export const VerificationRecordSchema = z
  .object({
    level: VerificationLevelSchema,
    methods: z.array(VerificationMethodSchema).max(4),
    /** ISO date (YYYY-MM-DD) of the check. Required unless draft. */
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Role only (e.g. "team member B", "external native English speaker"). No personal names. */
    reviewerRole: z.string().min(1).max(80).nullable(),
    /** Where the evidence is recorded (e.g. "docs/VALIDATION.md#phrase-checks"). Required unless draft. */
    evidence: z.string().min(1).max(200).nullable(),
    machineTranslationUsedForDraft: z.boolean(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.level === "draft") return;
    if (r.methods.length === 0) ctx.addIssue({ code: "custom", message: "verified phrases need at least one method" });
    if (!r.reviewedAt) ctx.addIssue({ code: "custom", message: "reviewedAt is required" });
    if (!r.reviewerRole) ctx.addIssue({ code: "custom", message: "reviewerRole is required" });
    if (!r.evidence) ctx.addIssue({ code: "custom", message: "evidence is required" });
    if (r.level === "team_reviewed" && !r.methods.includes("back_translation")) {
      ctx.addIssue({ code: "custom", message: "team_reviewed requires back_translation" });
    }
    if (r.level === "external_reviewed" && !r.methods.includes("native_speaker_review")) {
      ctx.addIssue({ code: "custom", message: "external_reviewed requires native_speaker_review" });
    }
  });
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

export const PhrasePurposeSchema = z.enum([
  "allergen_question", // "Does this dish contain {allergen}?"
  "cross_contact_question", // shared utensils / surfaces
  "frying_oil_question", // shared fryer / oil
  "broth_seasoning_question", // broth, sauces, seasonings
  "staff_answer_option", // yes / no / I don't know (staff points)
  "notice", // e.g. "I have a food allergy"
]);

export const PhraseSchema = z
  .object({
    id: z.string().regex(/^[A-Z0-9_]{2,64}$/),
    purpose: PhrasePurposeSchema,
    allergen: AllergenCodeSchema.nullable(),
    /** Text per language tag. */
    texts: z.record(LanguageTagSchema, z.string().min(1).max(300)),
    /** One verification record per language present in `texts`. */
    verification: z.record(LanguageTagSchema, VerificationRecordSchema),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const lang of Object.keys(p.texts)) {
      if (!(lang in p.verification)) {
        ctx.addIssue({ code: "custom", message: `missing verification record for ${lang}` });
      }
    }
    if (p.purpose === "allergen_question" && p.allergen === null) {
      ctx.addIssue({ code: "custom", message: "allergen_question needs an allergen" });
    }
  });
export type Phrase = z.infer<typeof PhraseSchema>;

/** A phrase text may be shown only when its language has a non-draft verification record. */
export function isDisplayable(phrase: Phrase, lang: string): boolean {
  const record = phrase.verification[lang];
  return phrase.texts[lang] !== undefined && record !== undefined && record.level !== "draft";
}
