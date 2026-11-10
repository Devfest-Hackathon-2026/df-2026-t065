import { z } from "zod";
import { ALLERGEN_CODES, type AllergenCode } from "@/contracts/allergens";
import {
  AllergenAssessmentSchema,
  ImageIssueSchema,
  LanguageTagSchema,
  hasVisibleContent,
  MentionKindSchema,
  UnconfirmedReasonSchema,
  type AllergenAssessment,
  type LanguageTag,
} from "@/contracts/analyze";

/*
 * INTERNAL model-output schema (what Gemini is asked to return).
 *
 * It is deliberately smaller than the public contract: the model never sets
 * ids, `readBy`, `confirmationRequired`, `verified`, `dataOrigin` or
 * `requestId` — the server adds those, so the model cannot claim anything is
 * verified or that confirmation is unnecessary. The public contract in
 * src/contracts/analyze.ts stays the only API definition; the converted result
 * is always validated against it (see pipeline.ts).
 *
 * Enum values are taken from the public contract so the two cannot drift.
 */

const CATEGORY = ["menu_mentions", "ai_inferred", "unconfirmed"] as const;
const READABILITY = ["clear", "partially_readable"] as const;
const STATUS = ["ok", "partial", "unreadable"] as const;
const MENTION_KINDS = MentionKindSchema.options;
const UNCONFIRMED_REASONS = UnconfirmedReasonSchema.options;
const IMAGE_ISSUES = ImageIssueSchema.options;

/*
 * Optional fields: omitted, null, or a string. "Omitted" and "null" mean the same.
 * Required fields (readText, and excerpt for menu_mentions) are NOT optional and are
 * validated strictly by the public contract (visible content, excerpt ⊂ readText).
 */
const Opt = <T extends z.ZodType>(t: T) => t.nullable().optional();

const ModelAssessment = z
  .object({
    code: z.enum(ALLERGEN_CODES),
    category: z.enum(CATEGORY),
    mentionKind: Opt(z.enum(MENTION_KINDS)),
    excerpt: Opt(z.string()),
    rationale: Opt(z.string()),
    unconfirmedReason: Opt(z.enum(UNCONFIRMED_REASONS)),
  })
  .strict();

const ModelItem = z
  .object({
    readText: z.string(),
    readTextLang: Opt(z.string()),
    translation: Opt(z.string()),
    readability: z.enum(READABILITY),
    allergens: z.array(ModelAssessment),
  })
  .strict();

const ModelNotice = z
  .object({
    readText: z.string(),
    readTextLang: Opt(z.string()),
    translation: Opt(z.string()),
    mentions: z.array(z.object({ code: z.enum(ALLERGEN_CODES), kind: z.enum(MENTION_KINDS) }).strict()),
  })
  .strict();

export const ModelOutputSchema = z
  .object({
    status: z.enum(STATUS),
    imageIssues: z.array(z.enum(IMAGE_ISSUES)),
    items: z.array(ModelItem),
    menuNotices: z.array(ModelNotice),
  })
  .strict();
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/**
 * JSON Schema sent as `responseJsonSchema`. Uses only the subset listed in the
 * SDK documentation (type, properties, required, enum, items, maxItems,
 * additionalProperties, description). It guides generation; it is NOT trusted:
 * the output is always re-validated with ModelOutputSchema and the public contract.
 */
export const MODEL_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "imageIssues", "items", "menuNotices"],
  properties: {
    status: { type: "string", enum: [...STATUS] },
    imageIssues: { type: "array", maxItems: 4, items: { type: "string", enum: [...IMAGE_ISSUES] } },
    items: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["readText", "readability", "allergens"],
        properties: {
          readText: { type: "string", description: "Dish text copied exactly as printed on the menu (max 300 chars)." },
          readTextLang: { type: "string", description: "Language tag of readText, e.g. 'en' or 'ja'." },
          translation: { type: "string", description: "Translation of readText into the user's language (max 300 chars)." },
          readability: { type: "string", enum: [...READABILITY] },
          allergens: {
            type: "array",
            maxItems: ALLERGEN_CODES.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "category"],
              properties: {
                code: { type: "string", enum: [...ALLERGEN_CODES] },
                category: { type: "string", enum: [...CATEGORY] },
                mentionKind: { type: "string", enum: [...MENTION_KINDS] },
                excerpt: { type: "string", description: "Exact substring of readText (menu_mentions only)." },
                rationale: { type: "string", description: "Short reason from general knowledge (ai_inferred only)." },
                unconfirmedReason: { type: "string", enum: [...UNCONFIRMED_REASONS] },
              },
            },
          },
        },
      },
    },
    menuNotices: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["readText", "mentions"],
        properties: {
          readText: { type: "string" },
          readTextLang: { type: "string" },
          translation: { type: "string" },
          mentions: {
            type: "array",
            maxItems: ALLERGEN_CODES.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "kind"],
              properties: {
                code: { type: "string", enum: [...ALLERGEN_CODES] },
                kind: { type: "string", enum: [...MENTION_KINDS] },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type ConversionResult = { ok: true; candidate: unknown } | { ok: false; failure: string };

/**
 * Converts validated model output into a CANDIDATE public response.
 * Category-specific fields must be consistent (e.g. menu_mentions needs a
 * mention kind and an excerpt, and nothing else); any inconsistency fails
 * the whole response — fields are never silently dropped or guessed.
 * One deliberate exception (EV-052): the ai_inferred rationale is validated and
 * then always published as null (see convertAssessment).
 * The candidate is not trusted: the caller validates it with the public schema
 * and the shared invariant checks.
 */
export function toPublicCandidate(
  out: ModelOutput,
  ctx: { requestId: string; userLang: LanguageTag },
): ConversionResult {
  const items: unknown[] = [];
  for (const [i, item] of out.items.entries()) {
    const allergens: AllergenAssessment[] = [];
    for (const a of item.allergens) {
      const converted = convertAssessment(a);
      if (converted === null) return { ok: false, failure: "model_inconsistent_assessment" };
      allergens.push(converted);
    }
    items.push({
      id: `item-${i + 1}`,
      readText: { text: item.readText, lang: langOrNull(item.readTextLang), readBy: "ai" },
      aiTranslation: translationOrNull(item.translation, ctx.userLang),
      readability: item.readability,
      allergens,
    });
  }
  const menuNotices = out.menuNotices.map((n, i) => ({
    id: `notice-${i + 1}`,
    readText: { text: n.readText, lang: langOrNull(n.readTextLang), readBy: "ai" },
    aiTranslation: translationOrNull(n.translation, ctx.userLang),
    mentions: n.mentions,
  }));
  return {
    ok: true,
    candidate: {
      requestId: ctx.requestId,
      status: out.status,
      dataOrigin: "ai_analysis",
      imageIssues: out.imageIssues,
      items,
      menuNotices,
    },
  };
}

function convertAssessment(a: z.infer<typeof ModelAssessment>): AllergenAssessment | null {
  const code: AllergenCode = a.code;
  // null and omitted are the same; an optional free-text field with no visible
  // content is also treated as absent. Required values are checked below and by
  // the public contract — they are never filled in or relaxed here.
  const mentionKind = a.mentionKind ?? undefined;
  const unconfirmedReason = a.unconfirmedReason ?? undefined;
  const excerpt = a.excerpt ?? undefined;
  const rationale = optionalText(a.rationale);
  const category = a.category;
  switch (category) {
    case "menu_mentions":
      // excerpt is REQUIRED here: passed through as-is, so a blank or invisible
      // excerpt is rejected by the public schema (hasLetterOrNumber / hasVisibleContent).
      if (mentionKind === undefined || excerpt === undefined) return null;
      if (rationale !== null || unconfirmedReason !== undefined) return null;
      return { code, category: "menu_mentions", mention: { kind: mentionKind, excerpt }, confirmationRequired: true };
    case "ai_inferred": {
      if (mentionKind !== undefined || optionalText(excerpt) !== null || unconfirmedReason !== undefined) return null;
      // EV-052: the model's rationale is NEVER published. It is AI free text that can
      // assert safety in endless paraphrases ("safe to eat", "no problem for …"), and no
      // word list can tell those from negations, warnings or quotes. The value is still
      // validated against the public contract first (length / visible content), so a
      // malformed rationale fails exactly as before; then it is dropped (null).
      // The category and confirmationRequired are unchanged.
      if (rationale !== null && !AllergenAssessmentSchema.safeParse({ code, category, rationale, confirmationRequired: true }).success) return null;
      return { code, category: "ai_inferred", rationale: null, confirmationRequired: true };
    }
    case "unconfirmed":
      if (mentionKind !== undefined || optionalText(excerpt) !== null || rationale !== null) return null;
      if (unconfirmedReason === undefined) return null;
      return { code, category: "unconfirmed", reason: unconfirmedReason, confirmationRequired: true };
  }
}

/** Optional free text: null when omitted, null, empty, whitespace-only or invisible-only. */
function optionalText(v: string | null | undefined): string | null {
  return typeof v === "string" && hasVisibleContent(v) ? v : null;
}

function translationOrNull(text: string | null | undefined, lang: LanguageTag) {
  const t = optionalText(text);
  return t === null ? null : { text: t, lang, verified: false as const };
}

/** An unusable language tag from the model becomes null (unknown), never a guess. */
function langOrNull(lang: string | null | undefined): string | null {
  return lang !== undefined && LanguageTagSchema.safeParse(lang).success ? lang : null;
}
