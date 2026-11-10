import { describe, expect, it } from "vitest";
import { PhraseSchema, VerificationRecordSchema, isDisplayable, type Phrase } from "@/contracts/phrases";

// Synthetic phrase used only to test the contract. Real phrase data arrives in PR4.
const teamReviewed = {
  level: "team_reviewed",
  methods: ["back_translation", "official_term_check"],
  reviewedAt: "2026-11-07",
  reviewerRole: "team member B",
  evidence: "docs/VALIDATION.md#phrase-checks",
  machineTranslationUsedForDraft: true,
} as const;
const draft = {
  level: "draft",
  methods: [],
  reviewedAt: null,
  reviewerRole: null,
  evidence: null,
  machineTranslationUsedForDraft: true,
} as const;

function phrase(verification: Record<string, unknown>): unknown {
  return {
    id: "Q_TEST_PEANUT",
    purpose: "allergen_question",
    allergen: "peanut",
    texts: { ja: "（テスト用）この料理に落花生は入っていますか？", en: "(test) Does this dish contain peanuts?" },
    verification,
  };
}

describe("phrase verification contract", () => {
  it("accepts team_reviewed with back-translation evidence", () => {
    expect(VerificationRecordSchema.safeParse(teamReviewed).success).toBe(true);
  });
  it.each([
    ["no methods", { ...teamReviewed, methods: [] }],
    ["no date", { ...teamReviewed, reviewedAt: null }],
    ["no reviewer role", { ...teamReviewed, reviewerRole: null }],
    ["no evidence", { ...teamReviewed, evidence: null }],
    ["team_reviewed without back_translation", { ...teamReviewed, methods: ["official_term_check"] }],
    ["external_reviewed without native review", { ...teamReviewed, level: "external_reviewed" }],
    ["machine translation as a method", { ...teamReviewed, methods: ["machine_translation"] }],
  ])("rejects a verified record with %s", (_n, rec) => {
    expect(VerificationRecordSchema.safeParse(rec).success).toBe(false);
  });
  it("requires a verification record for every language text", () => {
    expect(PhraseSchema.safeParse(phrase({ ja: teamReviewed })).success).toBe(false);
    expect(PhraseSchema.safeParse(phrase({ ja: teamReviewed, en: draft })).success).toBe(true);
  });
  it("never displays draft texts", () => {
    const p = PhraseSchema.parse(phrase({ ja: teamReviewed, en: draft })) as Phrase;
    expect(isDisplayable(p, "ja")).toBe(true);
    expect(isDisplayable(p, "en")).toBe(false);
    expect(isDisplayable(p, "fr")).toBe(false);
  });
});
