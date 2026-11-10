import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseStrictJson } from "@/server/gemini/strictJson";
import { evaluateCase, productionSubject, type Subject } from "./engine";
import { COVERAGE_TAGS, type CaseResult, type EvalCase, type Reference } from "./types";

/*
 * EXTENSION POINT (TEST ONLY): evaluate model outputs that were RECORDED
 * earlier, with the same engine and report format as the synthetic set.
 *
 * Intended use (later, only after approval): the team's 5 approved SYNTHETIC
 * menu images are sent to the approved Gemini model ONCE by a person with the
 * approval, the raw response text is saved in this format, and the files are
 * evaluated here OFFLINE. This module never calls a model, never reads
 * credentials and never records cost: a recorded file is replayed through the
 * production post-processing path by the same fake MenuModel.
 *
 * NOT implemented on purpose (requires approval, AGENTS.md §4): connecting to
 * Vertex AI, paid calls, GCP auth, recording measured cost, unapproved models,
 * production usage counters.
 *
 * Recorded files must not be committed until their content and rights are
 * reviewed (they contain model text; images themselves are never stored here).
 */

export const RECORDED_NOTICE_PREFIX = "RECORDED MODEL OUTPUT FOR A SYNTHETIC IMAGE";
export const FORMAT_SAMPLE_NOTICE_PREFIX = "SYNTHETIC TEST DATA (recorded-output format sample)";

const Label = z.enum([
  "menu_mentions:contains_claim",
  "menu_mentions:absence_claim",
  "menu_mentions:possible_presence",
  "menu_mentions:ambiguous",
  "ai_inferred",
  "unconfirmed:not_mentioned",
  "unconfirmed:unreadable",
  "unconfirmed:not_assessed",
]);

const Base = {
  schemaVersion: z.literal(1),
  /** Team-made synthetic image id, e.g. "SYN-IMG-01". Never a real store photo. */
  syntheticImageId: z.string().regex(/^SYN-IMG-\d{2}$/),
  /** sha256 of the image file, so a result can be tied to the exact image without storing it. */
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.iso.datetime(),
  input: z.object({ userLang: z.string(), storeLang: z.string(), allergens: z.array(z.string()).min(1) }).strict(),
  finishReason: z.string().optional(),
  /** The raw candidate text exactly as returned. */
  modelText: z.string(),
};

/**
 * Strict: unknown keys are rejected, so no cost, token-price, credential,
 * project or image field can be added to a recorded file.
 */
export const RecordedOutputSchema = z.discriminatedUnion("source", [
  z
    .object({
      _notice: z.string().startsWith(RECORDED_NOTICE_PREFIX),
      source: z.literal("recorded_gemini"),
      /** Model id actually used; must equal the approved model. */
      model: z.string().min(1),
      approval: z.object({ ref: z.string().min(1), approvedModel: z.string().min(1) }).strict(),
      ...Base,
    })
    .strict()
    .refine((r) => r.model === r.approval.approvedModel, "model must be the approved model"),
  z
    .object({
      _notice: z.string().startsWith(FORMAT_SAMPLE_NOTICE_PREFIX),
      source: z.literal("format_sample"),
      model: z.literal("none"),
      ...Base,
    })
    .strict(),
]);
export type RecordedOutput = z.infer<typeof RecordedOutputSchema>;

/** Ground truth of an approved synthetic image (written by the team). */
export const SyntheticImageReferenceSchema = z
  .object({
    syntheticImageId: z.string().regex(/^SYN-IMG-\d{2}$/),
    imageSha256: z.string().regex(/^[0-9a-f]{64}$/),
    coverage: z.array(z.enum(COVERAGE_TAGS)).min(1),
    items: z.array(z.object({ menuText: z.string().min(1), labels: z.record(z.string(), Label) }).strict()),
  })
  .strict();
export type SyntheticImageReference = z.infer<typeof SyntheticImageReferenceSchema>;

/**
 * Registry of the approved synthetic images' references.
 * EMPTY until the 5 synthetic images are approved (see README.md).
 */
export const SYNTHETIC_IMAGE_REFERENCES: readonly SyntheticImageReference[] = [];

export type LoadResult = { ok: true; record: RecordedOutput } | { ok: false; file: string; problem: "invalid_json" | "duplicate_key" | "too_large" | "too_deep" | "schema" };

/** Parses one recorded file with the production strict JSON parser (duplicate keys rejected). */
export function parseRecorded(text: string, file = "(inline)"): LoadResult {
  const parsed = parseStrictJson(text, { maxBytes: 2 * 1024 * 1024 });
  if (!parsed.ok) return { ok: false, file, problem: parsed.issue };
  const r = RecordedOutputSchema.safeParse(parsed.value);
  if (!r.success) return { ok: false, file, problem: "schema" };
  return { ok: true, record: r.data };
}

export function loadRecordedDir(dir: string): LoadResult[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => parseRecorded(readFileSync(join(dir, f), "utf8"), f));
}

/** Builds an evaluation case from a recorded output. No pipeline expectation exists for real outputs. */
export function recordedToCase(rec: RecordedOutput, references: readonly SyntheticImageReference[] = SYNTHETIC_IMAGE_REFERENCES): EvalCase {
  const ref = references.find((x) => x.syntheticImageId === rec.syntheticImageId);
  const unverifiable: EvalCase["unverifiable"] = [];
  if (!ref) unverifiable.push({ id: "NO-REFERENCE", statement: "参照値（正解）が未登録のため、読み取り・分類の正確さは未検証" });
  else if (ref.imageSha256 !== rec.imageSha256) {
    unverifiable.push({ id: "IMAGE-MISMATCH", statement: "記録の画像ハッシュが参照値と一致しないため、精度比較は無効（未検証）" });
  }
  const usable = ref && ref.imageSha256 === rec.imageSha256;
  return {
    id: `REC-${rec.syntheticImageId}`,
    title: `記録出力 ${rec.syntheticImageId}（${rec.source}）`,
    coverage: ref?.coverage ?? ["multiple_dishes"],
    input: rec.input,
    modelText: rec.modelText,
    ...(rec.finishReason !== undefined ? { finishReason: rec.finishReason } : {}),
    ...(usable ? { reference: { items: ref.items } as Reference } : {}),
    unverifiable,
  };
}

/** Evaluates recorded outputs offline (replayed by the fake model). */
export async function evaluateRecorded(
  records: readonly RecordedOutput[],
  references: readonly SyntheticImageReference[] = SYNTHETIC_IMAGE_REFERENCES,
  subject: Subject = productionSubject,
): Promise<{ cases: EvalCase[]; results: CaseResult[] }> {
  const cases = records.map((r) => recordedToCase(r, references));
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await evaluateCase(c, subject, { mode: "recorded" }));
  return { cases, results };
}
