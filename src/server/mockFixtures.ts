/*
 * Registry of SYNTHETIC mock fixtures (tests/fixtures/analyze/*.json).
 * Used only when mock mode is enabled (never in production, see analyzeMenu.ts).
 */
import conflicting from "../../tests/fixtures/analyze/conflicting_assessments_raw.json";
import crossContact from "../../tests/fixtures/analyze/cross_contact_notice.json";
import errorTimeout from "../../tests/fixtures/analyze/error_ai_timeout.json";
import invisibleEvidence from "../../tests/fixtures/analyze/invisible_evidence_raw.json";
import injection from "../../tests/fixtures/analyze/injection_in_image.json";
import invalidRaw from "../../tests/fixtures/analyze/invalid_output_raw.json";
import negation from "../../tests/fixtures/analyze/negation_claims.json";
import noMentions from "../../tests/fixtures/analyze/no_allergen_mentions.json";
import ok from "../../tests/fixtures/analyze/ok.json";
import partial from "../../tests/fixtures/analyze/partial.json";
import unreadable from "../../tests/fixtures/analyze/unreadable.json";

export const MOCK_FIXTURES = {
  ok,
  partial,
  unreadable,
  injection_in_image: injection,
  invalid_output_raw: invalidRaw,
  conflicting_assessments_raw: conflicting,
  invisible_evidence_raw: invisibleEvidence,
  error_ai_timeout: errorTimeout,
  negation_claims: negation,
  no_allergen_mentions: noMentions,
  cross_contact_notice: crossContact,
} as const;

export type MockScenario = keyof typeof MOCK_FIXTURES;

export function isMockScenario(s: string): s is MockScenario {
  return Object.prototype.hasOwnProperty.call(MOCK_FIXTURES, s);
}
