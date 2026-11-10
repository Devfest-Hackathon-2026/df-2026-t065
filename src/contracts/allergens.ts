import { z } from "zod";

/**
 * MVP allergen codes (fixed, shared contract).
 *
 * - Anything NOT in this list is unsupported. The app never treats an
 *   unsupported allergen as "absent" or "safe" — it simply cannot assess it,
 *   and the UI must say so.
 * - There is intentionally no vague "other nuts" bucket. Add individual codes
 *   (e.g. "almond") later through a contract change agreed by both developers.
 */
export const ALLERGEN_CODES = [
  "shrimp",
  "crab",
  "walnut",
  "wheat",
  "buckwheat",
  "egg",
  "milk",
  "peanut",
  "soy",
  "sesame",
  "fish",
] as const;

export const AllergenCodeSchema = z.enum(ALLERGEN_CODES);
export type AllergenCode = z.infer<typeof AllergenCodeSchema>;

export type AllergenDefinition = {
  code: AllergenCode;
  labels: { ja: string; en: string };
  /** Scope note shown to users/developers. Never a safety statement. */
  scopeNote?: { ja: string; en: string };
};

export const ALLERGENS: Readonly<Record<AllergenCode, AllergenDefinition>> = {
  shrimp: { code: "shrimp", labels: { ja: "えび", en: "Shrimp" } },
  crab: { code: "crab", labels: { ja: "かに", en: "Crab" } },
  walnut: { code: "walnut", labels: { ja: "くるみ", en: "Walnut" } },
  wheat: { code: "wheat", labels: { ja: "小麦", en: "Wheat" } },
  buckwheat: { code: "buckwheat", labels: { ja: "そば", en: "Buckwheat" } },
  egg: { code: "egg", labels: { ja: "卵", en: "Egg" } },
  milk: { code: "milk", labels: { ja: "乳", en: "Milk" } },
  peanut: { code: "peanut", labels: { ja: "落花生", en: "Peanut" } },
  soy: { code: "soy", labels: { ja: "大豆", en: "Soy" } },
  sesame: { code: "sesame", labels: { ja: "ごま", en: "Sesame" } },
  fish: {
    code: "fish",
    labels: { ja: "魚", en: "Fish" },
    scopeNote: {
      ja: "魚類全般の広い分類です。えび・かにとは別に扱います。特定の魚種の有無は判定できません。",
      en: "A broad category for fish in general, separate from shrimp and crab. Specific fish species cannot be determined.",
    },
  },
};
