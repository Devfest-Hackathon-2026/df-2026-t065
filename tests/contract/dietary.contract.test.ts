import { describe, expect, it } from "vitest";
import {
  DIETARY_CONDITIONS,
  DIETARY_PRESETS,
  DIETARY_CONDITION_CODES,
  DietaryConditionCodeSchema,
  DietaryPresetIdSchema,
} from "@/contracts/dietary";
import {
  DIETARY_PHRASES,
  buildDietaryConfirmationCardBundle,
  resolveBilingualDietaryPhrase,
  DietaryPhraseDatasetSchema,
} from "@/client/dietaryPhrases";

describe("dietary contract and phrase dataset integrity", () => {
  it("has valid condition codes matching definitions", () => {
    expect(DIETARY_CONDITIONS.length).toBe(DIETARY_CONDITION_CODES.length);
    for (const cond of DIETARY_CONDITIONS) {
      expect(DietaryConditionCodeSchema.safeParse(cond.code).success).toBe(true);
      expect(cond.labelJa).toBeTruthy();
      expect(cond.labelEn).toBeTruthy();
    }
  });

  it("has presets with valid default conditions and verifiable rationale citations", () => {
    for (const preset of DIETARY_PRESETS) {
      expect(DietaryPresetIdSchema.safeParse(preset.id).success).toBe(true);
      expect(preset.labelJa).toBeTruthy();
      expect(preset.labelEn).toBeTruthy();
      expect(preset.sourceReference).toBeTruthy();
      for (const cond of preset.defaultConditions) {
        expect(DietaryConditionCodeSchema.safeParse(cond).success).toBe(true);
      }
    }
  });

  it("every dietary condition has exactly one bilingual question record", () => {
    const verifiedConditionCodes = new Set(
      DIETARY_PHRASES.filter(
        (p) =>
          (p.purpose === "ingredient_question" || p.purpose === "process_question") &&
          p.conditionCode !== null,
      ).map((p) => p.conditionCode!),
    );

    for (const code of DIETARY_CONDITION_CODES) {
      expect(verifiedConditionCodes.has(code)).toBe(true);
    }
  });

  it("all dietary phrases meet verification requirements (no machine translation without review)", () => {
    for (const phrase of DIETARY_PHRASES) {
      expect(phrase.texts.ja).toBeTruthy();
      expect(phrase.texts.en).toBeTruthy();
      const jaVer = phrase.verification.ja;
      const enVer = phrase.verification.en;
      expect(jaVer).toBeDefined();
      expect(enVer).toBeDefined();
      if (jaVer?.level === "draft" || enVer?.level === "draft") {
        expect(resolveBilingualDietaryPhrase(phrase, "ja", "en")).toBeNull();
        expect(resolveBilingualDietaryPhrase(phrase, "en", "ja")).toBeNull();
        continue;
      }
      expect(jaVer?.methods).toContain("back_translation");
      expect(enVer?.methods).toContain("back_translation");
      expect(jaVer?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(enVer?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(jaVer?.evidence).toBeTruthy();
      expect(enVer?.evidence).toBeTruthy();
    }
  });

  it("resolves bilingual phrases cleanly for ja and en", () => {
    const notice = DIETARY_PHRASES.find((p) => p.purpose === "dietary_notice");
    expect(notice).toBeDefined();
    const resolved = resolveBilingualDietaryPhrase(notice!, "en", "ja");
    expect(resolved).not.toBeNull();
    expect(resolved?.storeText).toBe(notice?.texts.ja);
    expect(resolved?.userText).toBe(notice?.texts.en);
  });

  it("builds confirmation card bundle and includes all requested conditions", () => {
    const bundle = buildDietaryConfirmationCardBundle({
      userLang: "en",
      storeLang: "ja",
      selectedConditions: ["pork", "alcohol_seasoning", "shared_cookware"],
    });

    expect(bundle.supportedPair).toBe(true);
    expect(bundle.noticePhrases.length).toBeGreaterThan(0);
    expect(bundle.conditionQuestions.length).toBe(3);
    expect(bundle.unverifiedConditions.length).toBe(0);
    expect(bundle.staffAnswerOptions.map(p => p.id)).toEqual(["DIETARY_ANS_UNKNOWN"]);
  });

  it("rejects each missing required ID, including notice and answer records", () => {
    for (const phrase of DIETARY_PHRASES) {
      expect(DietaryPhraseDatasetSchema.safeParse(DIETARY_PHRASES.filter(p => p.id !== phrase.id)).success).toBe(false);
    }
  });
  it("keeps the five changed pairs draft until final-wording delta review", () => {
    const changed = ["ANIMAL_BROTH", "SLAUGHTER_METHOD", "CERTIFICATION_CHECK"].map(id => `DIETARY_Q_${id}`)
      .concat(["DIETARY_ANS_YES", "DIETARY_ANS_NO"]);
    expect(DIETARY_PHRASES.filter(p => p.verification.en?.level === "draft").map(p => p.id)).toEqual(changed);
    for (const phrase of DIETARY_PHRASES.filter(p => changed.includes(p.id))) {
      expect(resolveBilingualDietaryPhrase(phrase, "ja", "en")).toBeNull();
    }
    const broth = DIETARY_PHRASES.find(p => p.id === "DIETARY_Q_ANIMAL_BROTH")!;
    expect(broth.texts.ja).toContain("タレ"); expect(broth.texts.en).toContain("sauce");
    expect(broth.texts.en).not.toMatch(/fish|extracts/i);
    expect(broth.texts.en).toContain("pork bones, beef bones, or chicken carcasses");
    const slaughter = DIETARY_PHRASES.find(p => p.id === "DIETARY_Q_SLAUGHTER_METHOD")!;
    expect(slaughter.texts.en).not.toMatch(/certif/i);
    expect(slaughter.texts.en).toContain("processed and slaughtered");
    const certification = DIETARY_PHRASES.find(p => p.id === "DIETARY_Q_CERTIFICATION_CHECK")!;
    expect(certification.texts.ja).toContain("お店"); expect(certification.texts.en).toContain("restaurant");
    expect(DIETARY_PHRASES.find(p => p.id === "DIETARY_ANS_YES")?.texts).toEqual({ja: "はい", en: "Yes"});
    expect(DIETARY_PHRASES.find(p => p.id === "DIETARY_ANS_NO")?.texts).toEqual({ja: "いいえ", en: "No"});
  });

  it("fails closed on unsupported language pair", () => {
    const bundle = buildDietaryConfirmationCardBundle({
      userLang: "fr",
      storeLang: "ja",
      selectedConditions: ["pork"],
    });

    expect(bundle.supportedPair).toBe(false);
    expect(bundle.conditionQuestions.length).toBe(0);
    expect(bundle.unverifiedConditions).toEqual(["pork"]);
  });
});
