import { describe, expect, it } from "vitest";
import { ALLERGEN_CODES } from "@/contracts/allergens";
import {
  AnalyzeMenuResponseSchema,
  checkResponseInvariants,
  hasLetterOrNumber,
  hasVisibleContent,
  normalizeForMatch,
  projectToSelectedAllergens,
  type AnalyzeMenuResponse,
} from "@/contracts/analyze";
import { MOCK_FIXTURES } from "@/server/mockFixtures";

/*
 * MAJOR-2 (Codex PR1 re-audit): text made only of invisible characters
 * (format controls such as U+2063 / U+200E) passed the schema and the
 * excerpt ⊂ readText check, so a "menu mention" could exist with no visible
 * evidence. These tests pin the "visible content" requirement.
 */

const INVISIBLE_ONLY: [string, string][] = [
  ["U+2063 INVISIBLE SEPARATOR", "⁣"],
  ["U+200E LEFT-TO-RIGHT MARK", "‎"],
  ["U+200F RIGHT-TO-LEFT MARK", "‏"],
  ["U+2060 WORD JOINER", "⁠"],
  ["U+FEFF ZERO WIDTH NO-BREAK SPACE", "﻿"],
  ["U+200B ZERO WIDTH SPACE", "​"],
  ["U+200C ZERO WIDTH NON-JOINER", "‌"],
  ["U+200D ZERO WIDTH JOINER", "‍"],
  ["U+2061-2064 invisible operators", "⁡⁢⁤"],
  ["U+202A-202E bidi embedding controls", "‪‫‬‭‮"],
  ["U+2066-2069 bidi isolates", "⁦⁧⁨⁩"],
  ["U+00AD SOFT HYPHEN", "­"],
  ["invisible + half-width spaces", " ⁣ ‎ "],
  ["invisible + full-width space / newline / tab", "　⁣\n‏\t"],
  ["several invisible kinds", "​‌‍⁠⁣﻿‎‏"],
  ["lone combining acute accent (no base)", "́"],
  ["lone combining kana voiced mark (no base)", "゙"],
  ["variation selector only", "️"],
  ["Hangul filler (invisible letter)", "ㅤ"],
  ["Braille blank (invisible symbol)", "⠀"],
  ["control characters only", "\u0000\u0007\u001B"],
];

const VISIBLE_OK: [string, string][] = [
  ["Japanese", "海老天丼"],
  ["Japanese kana", "えびフライ"],
  ["English", "Shrimp Tempura"],
  ["numbers and dish name", "2 pcs Gyoza"],
  ["Japanese + English", "海老 Shrimp 天ぷら"],
  ["punctuation in a sentence", "Contains: shrimp, egg & milk."],
  ["Japanese punctuation", "えび・かに（甲殻類）を使用しています。"],
  ["base + combining acute", "Café au lait"],
  ["base + combining kana voiced mark", "がにクリームコロッケ"],
  ["sentence with spaces and newline", "Grilled fish\nserved with rice"],
  ["full-width alphanumerics", "ＳＨＲＩＭＰ　２"],
  ["emoji with ZWJ sequence (symbols are visible)", "🦐 Shrimp 👨‍🍳"],
];

function okBody(): AnalyzeMenuResponse {
  return AnalyzeMenuResponseSchema.parse(structuredClone(MOCK_FIXTURES.ok.body));
}

/** ok.json item-1: readText "Shrimp Tempura - lightly battered shrimp", allergens[0] = shrimp menu_mentions "Shrimp". */
function withItem1(readText: string, excerpt: string) {
  const body = structuredClone(MOCK_FIXTURES.ok.body) as unknown as {
    items: { readText: { text: string }; allergens: { mention?: { excerpt: string } }[] }[];
  };
  body.items[0]!.readText.text = readText;
  body.items[0]!.allergens[0]!.mention!.excerpt = excerpt;
  return AnalyzeMenuResponseSchema.safeParse(body);
}

describe("visible-content predicates", () => {
  it.each(INVISIBLE_ONLY)("hasVisibleContent rejects %s", (_n, s) => {
    expect(hasVisibleContent(s)).toBe(false);
    expect(hasLetterOrNumber(s)).toBe(false);
  });
  it.each(VISIBLE_OK)("hasVisibleContent accepts %s", (_n, s) => {
    expect(hasVisibleContent(s)).toBe(true);
  });
  it("hasLetterOrNumber requires a letter or digit (punctuation/symbols alone are not evidence)", () => {
    expect(hasLetterOrNumber("Shrimp")).toBe(true);
    expect(hasLetterOrNumber("2")).toBe(true);
    expect(hasLetterOrNumber("海老")).toBe(true);
    expect(hasLetterOrNumber("!!")).toBe(false);
    expect(hasLetterOrNumber("・")).toBe(false);
    expect(hasLetterOrNumber("🦐")).toBe(false);
    expect(hasVisibleContent("!!")).toBe(true);
  });
  it("normalizeForMatch stays a matching helper and does not decide visibility", () => {
    // A visible string normalizes to something comparable…
    expect(normalizeForMatch("Ｓｈｒｉｍｐ⁣ Tempura")).toBe("shrimp tempura");
    // …and the combining mark is kept (composed), not deleted.
    expect(normalizeForMatch("Café")).toBe("café");
  });
});

describe("menu_mentions cannot exist without visible evidence", () => {
  it.each(INVISIBLE_ONLY)("rejects an excerpt of only %s", (_n, s) => {
    expect(withItem1("Shrimp Tempura - lightly battered shrimp", s).success).toBe(false);
  });
  it.each(INVISIBLE_ONLY)("rejects a readText of only %s", (_n, s) => {
    expect(withItem1(s, "Shrimp").success).toBe(false);
  });
  it.each([
    ["U+2063 / U+2063", "⁣", "⁣"],
    ["U+2063 / U+200E", "⁣", "‎"],
    ["U+200E / U+200E", "‎", "‎"],
  ])("rejects invisible readText AND excerpt together (%s) — the reported reproduction", (_n, readText, excerpt) => {
    expect(withItem1(readText, excerpt).success).toBe(false);
  });
  it("rejects an excerpt made only of punctuation (no letter or digit)", () => {
    expect(withItem1("Shrimp!! Tempura", "!!").success).toBe(false);
  });
  it("the invisible-evidence raw fixture is rejected by the schema", () => {
    expect(AnalyzeMenuResponseSchema.safeParse(MOCK_FIXTURES.invisible_evidence_raw.body).success).toBe(false);
  });
  it.each([
    ["Japanese", "海老天丼（えび入り）", "海老"],
    ["English", "Shrimp Tempura - lightly battered shrimp", "battered shrimp"],
    ["mixed", "海老 Shrimp 天ぷら 2本", "Shrimp 天ぷら"],
    ["combining mark", "Café au lait with shrimp", "Café"],
    ["kana + combining voiced mark", "がにクリームコロッケ", "がに"],
    ["invisible char inside visible text", "Shrimp⁣ Tempura", "shrimp tempura"],
  ])("accepts visible evidence: %s", (_n, readText, excerpt) => {
    const r = withItem1(readText, excerpt);
    expect(r.success).toBe(true);
    if (r.success) expect(checkResponseInvariants(r.data, ["shrimp", "wheat", "egg", "milk"])).toEqual([]);
  });
});

describe("other AI free text needs visible content too", () => {
  it.each(INVISIBLE_ONLY)("rejects a translation of only %s", (_n, s) => {
    const b = structuredClone(MOCK_FIXTURES.ok.body) as unknown as { items: { aiTranslation: { text: string } }[] };
    b.items[0]!.aiTranslation.text = s;
    expect(AnalyzeMenuResponseSchema.safeParse(b).success).toBe(false);
  });
  it.each(INVISIBLE_ONLY)("rejects an AI rationale of only %s", (_n, s) => {
    const b = structuredClone(MOCK_FIXTURES.ok.body) as unknown as { items: { allergens: { rationale?: string | null }[] }[] };
    b.items[0]!.allergens[1]!.rationale = s; // ok.json item-1 allergens[1] is wheat / ai_inferred
    expect(AnalyzeMenuResponseSchema.safeParse(b).success).toBe(false);
  });
  it.each(INVISIBLE_ONLY)("rejects a menu notice readText of only %s", (_n, s) => {
    const b = structuredClone(MOCK_FIXTURES.cross_contact_notice.body) as unknown as {
      menuNotices: { readText: { text: string } }[];
    };
    b.menuNotices[0]!.readText.text = s;
    expect(AnalyzeMenuResponseSchema.safeParse(b).success).toBe(false);
  });
});

describe("safety regressions", () => {
  it("all existing valid fixtures still pass (Japanese and English, both language pairs)", () => {
    for (const key of ["ok", "partial", "unreadable", "injection_in_image", "negation_claims", "no_allergen_mentions", "cross_contact_notice"] as const) {
      expect(AnalyzeMenuResponseSchema.safeParse(MOCK_FIXTURES[key].body).success, key).toBe(true);
    }
  });
  it("absence_claim is still only a menu mention that requires confirmation", () => {
    const parsed = AnalyzeMenuResponseSchema.parse(MOCK_FIXTURES.negation_claims.body);
    const absences = parsed.items.flatMap((i) => i.allergens).filter((a) => a.category === "menu_mentions" && a.mention.kind === "absence_claim");
    expect(absences.length).toBe(2);
    for (const a of absences) expect(a.confirmationRequired).toBe(true);
    // An absence claim with invisible evidence is rejected like any other mention.
    const b = structuredClone(MOCK_FIXTURES.negation_claims.body) as unknown as { items: { allergens: { mention: { excerpt: string } }[] }[] };
    b.items[1]!.allergens[0]!.mention.excerpt = "⁣";
    expect(AnalyzeMenuResponseSchema.safeParse(b).success).toBe(false);
  });
  it("the 11 allergen codes are unchanged", () => {
    expect(ALLERGEN_CODES.length).toBe(11);
  });
  it("duplicates are still detected and missing allergens are still filled", () => {
    const body = okBody();
    const dup = { ...body, items: [{ ...body.items[0]!, allergens: [...body.items[0]!.allergens, body.items[0]!.allergens[3]!] }] };
    expect(projectToSelectedAllergens(dup, ["shrimp"]).ok).toBe(false);
    const p = projectToSelectedAllergens(body, ["shrimp", "peanut"]);
    expect(p.ok && p.response.items[0]!.allergens[1]).toEqual({
      code: "peanut",
      category: "unconfirmed",
      reason: "not_assessed",
      confirmationRequired: true,
    });
  });
});
