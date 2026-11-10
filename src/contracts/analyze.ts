import { z } from "zod";
import { ALLERGEN_CODES, AllergenCodeSchema, type AllergenCode } from "./allergens";

/*
 * Shared API contract for POST /api/analyze-menu (multipart/form-data).
 * This file is the single implementation-level source of truth for the API.
 * Changing it requires agreement from both developers (see AGENTS.md).
 *
 * SAFETY INVARIANTS (enforced by schema shape + helpers below):
 *  - No field can express "safe", "edible", "allergen absent" or any eating verdict.
 *    All objects are strict: unknown keys (e.g. `safe`) are rejected.
 *  - Every result is AI-derived. Even text "read from the menu" is an AI reading
 *    that may be wrong (`readBy: "ai"`). Nothing here is verified ingredient data.
 *  - Every selected allergen appears exactly once per item, in one of three
 *    categories. Every category requires confirmation with staff.
 *  - A menu *absence claim* ("peanut-free") is only a claim printed on the menu.
 *    It is NOT a safety verdict and still requires confirmation.
 */

// ---------------------------------------------------------------------------
// Languages (config-driven; not a permanent "must differ" rule)
// ---------------------------------------------------------------------------

/** Language tag shape (BCP 47 subset). Kept generic so languages can be added. */
export const LanguageTagSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "invalid language tag");
export type LanguageTag = z.infer<typeof LanguageTagSchema>;

export type LanguagePair = { readonly userLang: LanguageTag; readonly storeLang: LanguageTag };

/**
 * MVP configuration: the ONLY language pairs the product currently supports.
 * The UI must offer only these pairs. Adding a pair requires verified phrase
 * cards for it (see phrases.ts) — not just an entry here.
 */
export const SUPPORTED_LANGUAGE_PAIRS: readonly LanguagePair[] = [
  { userLang: "ja", storeLang: "en" }, // Japanese traveler abroad
  { userLang: "en", storeLang: "ja" }, // English-speaking visitor in Japan
];

export function isSupportedLanguagePair(
  userLang: string,
  storeLang: string,
  pairs: readonly LanguagePair[] = SUPPORTED_LANGUAGE_PAIRS,
): boolean {
  return pairs.some((p) => p.userLang === userLang && p.storeLang === storeLang);
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const IMAGE_CONSTRAINTS = {
  maxBytes: 4 * 1024 * 1024,
  mimeTypes: ["image/jpeg", "image/png", "image/webp"] as const,
} as const;

/** Text fields of the multipart request. The image is validated separately. */
export const AnalyzeMenuFieldsSchema = z
  .object({
    userLang: LanguageTagSchema,
    storeLang: LanguageTagSchema,
    allergens: z
      .array(AllergenCodeSchema)
      .min(1)
      .max(ALLERGEN_CODES.length)
      .refine((a) => new Set(a).size === a.length, "duplicate allergen codes"),
  })
  .strict();
export type AnalyzeMenuFields = z.infer<typeof AnalyzeMenuFieldsSchema>;

export const InvalidInputReasonSchema = z.enum([
  "malformed_request",
  "image_missing",
  "image_too_large",
  "unsupported_image_type",
  "unsupported_language_pair",
  "invalid_allergens",
]);
export type InvalidInputReason = z.infer<typeof InvalidInputReasonSchema>;

export type ParsedAnalyzeMenuForm =
  | { ok: true; fields: AnalyzeMenuFields; image: Blob }
  | { ok: false; reason: InvalidInputReason };

/**
 * Allowed multipart field names (closed set, consistent with the strict schemas).
 * - image, userLang, storeLang: exactly one value each
 * - allergens: one or more values (repeated field)
 * Any other field name → INVALID_INPUT / malformed_request.
 * The client posts with fetch + FormData (not a Next.js Server Action), so no
 * framework-generated fields (e.g. `$ACTION_ID_*`) are expected.
 */
export const ANALYZE_FORM_FIELDS = {
  single: ["image", "userLang", "storeLang"],
  repeated: ["allergens"],
} as const;

/**
 * Pure validation of the multipart form. Usable by the client (pre-check)
 * and the server (authoritative check).
 */
export function parseAnalyzeMenuForm(
  form: FormData,
  pairs: readonly LanguagePair[] = SUPPORTED_LANGUAGE_PAIRS,
): ParsedAnalyzeMenuForm {
  const allowed = new Set<string>([...ANALYZE_FORM_FIELDS.single, ...ANALYZE_FORM_FIELDS.repeated]);
  for (const key of new Set(form.keys())) {
    if (!allowed.has(key)) return { ok: false, reason: "malformed_request" };
  }
  for (const key of ANALYZE_FORM_FIELDS.single) {
    if (form.getAll(key).length > 1) return { ok: false, reason: "malformed_request" };
  }
  const userLang = form.get("userLang");
  const storeLang = form.get("storeLang");
  if (typeof userLang !== "string" || typeof storeLang !== "string") {
    return { ok: false, reason: "malformed_request" };
  }
  const fields = AnalyzeMenuFieldsSchema.safeParse({
    userLang,
    storeLang,
    allergens: form.getAll("allergens"),
  });
  if (!fields.success) {
    const langIssue = fields.error.issues.some((i) => i.path[0] === "userLang" || i.path[0] === "storeLang");
    return { ok: false, reason: langIssue ? "malformed_request" : "invalid_allergens" };
  }
  if (!isSupportedLanguagePair(fields.data.userLang, fields.data.storeLang, pairs)) {
    return { ok: false, reason: "unsupported_language_pair" };
  }
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size === 0) {
    return { ok: false, reason: "image_missing" };
  }
  if (!(IMAGE_CONSTRAINTS.mimeTypes as readonly string[]).includes(image.type)) {
    return { ok: false, reason: "unsupported_image_type" };
  }
  if (image.size > IMAGE_CONSTRAINTS.maxBytes) {
    return { ok: false, reason: "image_too_large" };
  }
  return { ok: true, fields: fields.data, image };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/*
 * Text handling responsibilities (kept separate on purpose):
 *
 *  - hasVisibleContent / hasLetterOrNumber — VALIDATION. Decide whether a string
 *    shows anything to a person. Used by the schema (below), so invalid text is
 *    rejected before any post-processing or rendering.
 *  - normalizeForMatch — COMPARISON ONLY. Makes two AI outputs comparable for the
 *    excerpt ⊂ readText consistency check. It never decides validity and its
 *    output is never displayed.
 *
 * Visibility is decided by Unicode general category, not by a deny-list:
 *   visible  = Letter (L), Number (N), Punctuation (P), Symbol (S)
 *   not visible on its own = Separator (Z: spaces), Other (C: controls Cc,
 *   format Cf such as U+200B–U+200F / U+2060–U+2064 / U+FEFF / bidi controls,
 *   private use Co, unassigned Cn, surrogates Cs) and Mark (M: combining marks
 *   need a base character; a base + mark is accepted because the base is L).
 * A tiny supplementary set covers characters whose category is L or S but which
 * render as blank (Hangul fillers, Braille blank). This is a known, documented
 * limitation for scripts beyond the MVP's Japanese and English; see
 * docs/VALIDATION.md.
 */
const VISIBLE_CATEGORY = /[\p{L}\p{N}\p{P}\p{S}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
/** Category L/S characters that render as blank: U+115F, U+1160, U+3164, U+FFA0 (Hangul fillers), U+2800 (Braille blank). */
const BLANK_RENDERING = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

/** True if the string contains at least one character a person can see. */
export function hasVisibleContent(s: string): boolean {
  return VISIBLE_CATEGORY.test(s.replace(BLANK_RENDERING, ""));
}

/** True if the string contains at least one visible letter or digit (required for evidence excerpts). */
export function hasLetterOrNumber(s: string): boolean {
  return LETTER_OR_NUMBER.test(s.replace(BLANK_RENDERING, ""));
}

/**
 * Normalization for the excerpt ⊂ readText CONSISTENCY check only:
 * NFKC (full-width → half-width, composes base + combining mark), remove
 * format characters (Unicode category Cf, e.g. U+200B–U+200F, U+2060–U+2064,
 * U+FEFF, bidi controls) so they cannot split or fake a match, lowercase,
 * collapse whitespace, trim. Never a safety guarantee; never used for display.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * AI-produced free text shown to people (read text, translations, rationale).
 * Plain text only: render with normal JSX escaping, never as HTML.
 * Must contain visible content (rejects whitespace-only and invisible-only text).
 */
const AiText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(hasVisibleContent, "text must contain visible characters")
    .refine((s) => normalizeForMatch(s).length > 0, "text must not be blank after normalization");

/**
 * Evidence excerpt of a menu mention: must be visible AND contain a letter or
 * digit, so a "menu mentions" result can never stand on invisible characters or
 * bare punctuation. Containment in readText is checked separately (consistency only).
 */
const EvidenceExcerpt = AiText(200).refine(hasLetterOrNumber, "evidence excerpt must contain a letter or digit");

/** Text the AI read from the image. May be a misreading. Never verified data. */
export const AiReadTextSchema = z
  .object({
    text: AiText(300),
    lang: LanguageTagSchema.nullable(),
    readBy: z.literal("ai"),
  })
  .strict();

/** AI translation for the user's convenience. Always unverified. */
export const AiTranslationSchema = z
  .object({
    text: AiText(300),
    lang: LanguageTagSchema,
    verified: z.literal(false),
  })
  .strict();

/**
 * What kind of statement the menu text makes about an allergen.
 * This classifies the *printed claim*, not the real ingredients.
 *  - contains_claim:    "Contains peanuts", "with shrimp"
 *  - absence_claim:     "Peanut-free", "No peanuts added"  → NOT a safety verdict
 *  - possible_presence: "May contain peanuts", "Prepared in a facility handling peanuts", shared fryer
 *  - ambiguous:         mentioned but meaning unclear
 */
export const MentionKindSchema = z.enum(["contains_claim", "absence_claim", "possible_presence", "ambiguous"]);
export type MentionKind = z.infer<typeof MentionKindSchema>;

export const UnconfirmedReasonSchema = z.enum([
  "not_mentioned", // not on the menu → NOT evidence of absence
  "unreadable", // the relevant part of the image could not be read
  "not_assessed", // the analysis did not return this allergen (filled in as unconfirmed)
]);

const MenuMentionsAssessment = z
  .object({
    code: AllergenCodeSchema,
    category: z.literal("menu_mentions"),
    mention: z
      .object({
        kind: MentionKindSchema,
        /** AI-read excerpt that must appear in the item's readText (consistency check only). */
        excerpt: EvidenceExcerpt,
      })
      .strict(),
    confirmationRequired: z.literal(true),
  })
  .strict();

const AiInferredAssessment = z
  .object({
    code: AllergenCodeSchema,
    category: z.literal("ai_inferred"),
    /** Short AI explanation from general knowledge (e.g. "tempura batter usually contains wheat"). */
    rationale: AiText(200).nullable(),
    confirmationRequired: z.literal(true),
  })
  .strict();

const UnconfirmedAssessment = z
  .object({
    code: AllergenCodeSchema,
    category: z.literal("unconfirmed"),
    reason: UnconfirmedReasonSchema,
    confirmationRequired: z.literal(true),
  })
  .strict();

export const AllergenAssessmentSchema = z.discriminatedUnion("category", [
  MenuMentionsAssessment,
  AiInferredAssessment,
  UnconfirmedAssessment,
]);
export type AllergenAssessment = z.infer<typeof AllergenAssessmentSchema>;
export type AssessmentCategory = AllergenAssessment["category"];

export const MenuItemSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    readText: AiReadTextSchema,
    aiTranslation: AiTranslationSchema.nullable(),
    readability: z.enum(["clear", "partially_readable"]),
    allergens: z.array(AllergenAssessmentSchema).max(ALLERGEN_CODES.length),
  })
  .strict();
export type MenuItem = z.infer<typeof MenuItemSchema>;

/** Menu-wide notices (e.g. "All fried items share one fryer"). Apply to every item. */
export const MenuNoticeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    readText: AiReadTextSchema,
    aiTranslation: AiTranslationSchema.nullable(),
    mentions: z
      .array(z.object({ code: AllergenCodeSchema, kind: MentionKindSchema }).strict())
      .max(ALLERGEN_CODES.length),
  })
  .strict();
export type MenuNotice = z.infer<typeof MenuNoticeSchema>;

export const ImageIssueSchema = z.enum(["blurry", "cropped", "low_light", "not_a_menu"]);

export const AnalyzeMenuResponseSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    status: z.enum(["ok", "partial", "unreadable"]),
    /** "mock_fixture" = synthetic test data. Must never be presented as a real analysis. */
    dataOrigin: z.enum(["ai_analysis", "mock_fixture"]),
    imageIssues: z.array(ImageIssueSchema).max(4),
    items: z.array(MenuItemSchema).max(30),
    menuNotices: z.array(MenuNoticeSchema).max(10),
  })
  .strict();
export type AnalyzeMenuResponse = z.infer<typeof AnalyzeMenuResponseSchema>;

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

export const ErrorCodeSchema = z.enum(["INVALID_INPUT", "RATE_LIMITED", "AI_DISABLED", "AI_TIMEOUT", "AI_FAILED"]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  AI_DISABLED: 503,
  AI_TIMEOUT: 504,
  AI_FAILED: 502,
};

export const ERROR_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  INVALID_INPUT: false,
  RATE_LIMITED: true,
  AI_DISABLED: false,
  AI_TIMEOUT: true,
  AI_FAILED: true,
};

/**
 * On ANY error the UI must keep the card-only path available
 * (confirmation cards are built from the user's settings, without AI).
 */
export const AnalyzeMenuErrorSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    error: z
      .object({
        code: ErrorCodeSchema,
        retryable: z.boolean(),
        reason: InvalidInputReasonSchema.optional(),
      })
      .strict()
      .refine((e) => e.retryable === ERROR_RETRYABLE[e.code], "retryable must match the code")
      .refine((e) => e.reason === undefined || e.code === "INVALID_INPUT", "reason is only for INVALID_INPUT"),
  })
  .strict();
export type AnalyzeMenuError = z.infer<typeof AnalyzeMenuErrorSchema>;

export function makeError(requestId: string, code: ErrorCode, reason?: InvalidInputReason): AnalyzeMenuError {
  return {
    requestId,
    error: { code, retryable: ERROR_RETRYABLE[code], ...(reason ? { reason } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Cross-field invariants
// ---------------------------------------------------------------------------
//
// Order of processing (must not be changed without both developers' agreement):
//   1. findIntegrityViolations  — on the response AS RECEIVED, before anything is
//      removed, reordered or filled in. Duplicates/conflicts are detected here.
//   2. projectToSelectedAllergens — only if step 1 found nothing: drops allergens
//      the user did not select (reported, not silent) and fills missing ones.
//   3. checkResponseInvariants — full re-check of the projected response.
// Any violation → the response is invalid (fail safe: AI_FAILED). Conflicting
// assessments are never resolved by keeping one of them, so a menu "contains"
// mention can never be silently replaced by "unconfirmed" or an absence claim.

export type InvariantViolation = { path: string; message: string };

/**
 * Selection-independent checks on a schema-valid response.
 * Note: excerpt ⊂ readText is a CONSISTENCY check between two AI outputs.
 * Passing it does not verify any real ingredient.
 */
export function findIntegrityViolations(res: AnalyzeMenuResponse): InvariantViolation[] {
  const v: InvariantViolation[] = [];

  if (res.status === "unreadable" && (res.items.length > 0 || res.menuNotices.length > 0)) {
    v.push({ path: "status", message: "unreadable responses must not contain items or notices" });
  }
  if (res.status === "ok" && res.items.length === 0) {
    v.push({ path: "status", message: "ok responses must contain at least one item" });
  }

  const itemIds = new Set<string>();
  res.items.forEach((item, i) => {
    if (itemIds.has(item.id)) v.push({ path: `items[${i}].id`, message: "duplicate item id" });
    itemIds.add(item.id);

    const byCode = new Map<AllergenCode, AllergenAssessment[]>();
    item.allergens.forEach((a, j) => {
      byCode.set(a.code, [...(byCode.get(a.code) ?? []), a]);
      if (
        a.category === "menu_mentions" &&
        !normalizeForMatch(item.readText.text).includes(normalizeForMatch(a.mention.excerpt))
      ) {
        v.push({ path: `items[${i}].allergens[${j}].mention.excerpt`, message: "excerpt does not appear in readText" });
      }
    });
    for (const [code, list] of byCode) {
      if (list.length > 1) {
        v.push({ path: `items[${i}].allergens`, message: `duplicate assessment for ${code}` });
        const labels = new Set(list.map(describeAssessment));
        if (labels.size > 1) {
          v.push({
            path: `items[${i}].allergens`,
            message: `conflicting assessments for ${code}: ${[...labels].sort().join(" vs ")}`,
          });
        }
      }
    }
  });

  const noticeIds = new Set<string>();
  res.menuNotices.forEach((n, i) => {
    if (noticeIds.has(n.id)) v.push({ path: `menuNotices[${i}].id`, message: "duplicate notice id" });
    noticeIds.add(n.id);
    const kinds = new Map<AllergenCode, Set<MentionKind>>();
    n.mentions.forEach((m) => kinds.set(m.code, new Set([...(kinds.get(m.code) ?? []), m.kind])));
    const counts = new Map<AllergenCode, number>();
    n.mentions.forEach((m) => counts.set(m.code, (counts.get(m.code) ?? 0) + 1));
    for (const [code, count] of counts) {
      if (count > 1) v.push({ path: `menuNotices[${i}].mentions`, message: `duplicate mention for ${code}` });
      const k = kinds.get(code)!;
      if (k.size > 1) {
        v.push({
          path: `menuNotices[${i}].mentions`,
          message: `conflicting mentions for ${code}: ${[...k].sort().join(" vs ")}`,
        });
      }
    }
  });
  return v;
}

function describeAssessment(a: AllergenAssessment): string {
  return a.category === "menu_mentions" ? `menu_mentions:${a.mention.kind}` : a.category;
}

/** Checks that exactly the selected allergens are assessed in every item. */
export function findSelectionViolations(
  res: AnalyzeMenuResponse,
  selected: readonly AllergenCode[],
): InvariantViolation[] {
  const v: InvariantViolation[] = [];
  const selectedSet = new Set(selected);
  res.items.forEach((item, i) => {
    const present = new Set(item.allergens.map((a) => a.code));
    item.allergens.forEach((a, j) => {
      if (!selectedSet.has(a.code)) {
        v.push({ path: `items[${i}].allergens[${j}]`, message: `allergen ${a.code} was not selected` });
      }
    });
    for (const code of selected) {
      if (!present.has(code)) v.push({ path: `items[${i}].allergens`, message: `missing assessment for ${code}` });
    }
  });
  res.menuNotices.forEach((n, i) => {
    n.mentions.forEach((m, j) => {
      if (!selectedSet.has(m.code)) {
        v.push({ path: `menuNotices[${i}].mentions[${j}]`, message: `allergen ${m.code} was not selected` });
      }
    });
  });
  return v;
}

/** All invariants: integrity (selection-independent) + selection coverage. */
export function checkResponseInvariants(
  res: AnalyzeMenuResponse,
  selected: readonly AllergenCode[],
): InvariantViolation[] {
  return [...findIntegrityViolations(res), ...findSelectionViolations(res, selected)];
}

/**
 * Adds missing selected allergens as `unconfirmed` / `not_assessed`.
 * It ONLY appends: existing entries (including duplicates) are kept untouched,
 * so later checks still see them. Missing data is never interpreted as absence.
 */
export function fillMissingAsUnconfirmed(items: readonly MenuItem[], selected: readonly AllergenCode[]): MenuItem[] {
  return items.map((item) => {
    const present = new Set(item.allergens.map((a) => a.code));
    const missing = selected
      .filter((code) => !present.has(code))
      .map((code): AllergenAssessment => ({ code, category: "unconfirmed", reason: "not_assessed", confirmationRequired: true }));
    return { ...item, allergens: [...item.allergens, ...missing] };
  });
}

export type DroppedAssessment = { path: string; code: AllergenCode };

export type ProjectionResult =
  | { ok: true; response: AnalyzeMenuResponse; droppedUnselected: DroppedAssessment[] }
  | { ok: false; violations: InvariantViolation[] };

/**
 * Projects a schema-valid response onto the user's selected allergens.
 * Refuses (ok: false) if the response as received has any integrity violation,
 * so duplicates/conflicts are never hidden by the projection. Allergens the user
 * did not select are removed and reported in `droppedUnselected`.
 */
export function projectToSelectedAllergens(
  res: AnalyzeMenuResponse,
  selected: readonly AllergenCode[],
): ProjectionResult {
  const integrity = findIntegrityViolations(res);
  if (integrity.length > 0) return { ok: false, violations: integrity };

  const selectedSet = new Set(selected);
  const droppedUnselected: DroppedAssessment[] = [];
  const order = new Map(selected.map((code, idx) => [code, idx]));

  const items = fillMissingAsUnconfirmed(
    res.items.map((item, i) => ({
      ...item,
      allergens: item.allergens.filter((a, j) => {
        if (selectedSet.has(a.code)) return true;
        droppedUnselected.push({ path: `items[${i}].allergens[${j}]`, code: a.code });
        return false;
      }),
    })),
    selected,
  ).map((item) => ({
    ...item,
    // Safe to reorder: integrity check guaranteed one assessment per code.
    allergens: [...item.allergens].sort((a, b) => order.get(a.code)! - order.get(b.code)!),
  }));

  const menuNotices = res.menuNotices.map((n, i) => ({
    ...n,
    mentions: n.mentions.filter((m, j) => {
      if (selectedSet.has(m.code)) return true;
      droppedUnselected.push({ path: `menuNotices[${i}].mentions[${j}]`, code: m.code });
      return false;
    }),
  }));

  const response: AnalyzeMenuResponse = { ...res, items, menuNotices };
  const final = checkResponseInvariants(response, selected);
  if (final.length > 0) return { ok: false, violations: final };
  return { ok: true, response, droppedUnselected };
}
