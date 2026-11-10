import type { AllergenCode } from "@/contracts/allergens";
import {
  AnalyzeMenuResponseSchema,
  checkResponseInvariants,
  projectToSelectedAllergens,
  type AnalyzeMenuResponse,
} from "@/contracts/analyze";

/*
 * The single validation path shared by the mock fixtures and real Gemini output.
 * It reuses the PR1 contract helpers (no re-implementation):
 *
 *   1. AnalyzeMenuResponseSchema   — public schema (strict; hasVisibleContent /
 *                                    hasLetterOrNumber are applied inside it)
 *   2. projectToSelectedAllergens  — runs findIntegrityViolations on the response
 *                                    AS RECEIVED (duplicates / conflicts / excerpt
 *                                    consistency via normalizeForMatch) BEFORE it
 *                                    drops unselected codes and calls
 *                                    fillMissingAsUnconfirmed
 *   3. AnalyzeMenuResponseSchema   — final schema check with the server's
 *                                    requestId and dataOrigin
 *   4. checkResponseInvariants     — final invariant check
 *
 * Any failure → the response is invalid (the caller returns AI_FAILED).
 */

export type FinalizeResult = { ok: true; body: AnalyzeMenuResponse } | { ok: false; failure: string };

export function finalizeCandidate(
  candidate: unknown,
  selected: readonly AllergenCode[],
  server: { requestId: string; dataOrigin: AnalyzeMenuResponse["dataOrigin"] },
): FinalizeResult {
  const parsed = AnalyzeMenuResponseSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, failure: "public_schema" };

  const projected = projectToSelectedAllergens(parsed.data, selected);
  if (!projected.ok) return { ok: false, failure: "invariants" };

  const final = AnalyzeMenuResponseSchema.safeParse({ ...projected.response, ...server });
  if (!final.success) return { ok: false, failure: "public_schema_final" };
  if (checkResponseInvariants(final.data, selected).length > 0) return { ok: false, failure: "invariants_final" };
  return { ok: true, body: final.data };
}
