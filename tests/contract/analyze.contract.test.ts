import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALLERGENS, ALLERGEN_CODES, AllergenCodeSchema, type AllergenCode } from "@/contracts/allergens";
import {
  AnalyzeMenuErrorSchema,
  AnalyzeMenuFieldsSchema,
  AnalyzeMenuResponseSchema,
  ERROR_HTTP_STATUS,
  ERROR_RETRYABLE,
  ErrorCodeSchema,
  IMAGE_CONSTRAINTS,
  SUPPORTED_LANGUAGE_PAIRS,
  ANALYZE_FORM_FIELDS,
  checkResponseInvariants,
  fillMissingAsUnconfirmed,
  findIntegrityViolations,
  normalizeForMatch,
  projectToSelectedAllergens,
  isSupportedLanguagePair,
  makeError,
  parseAnalyzeMenuForm,
  type AnalyzeMenuResponse,
} from "@/contracts/analyze";
import { MOCK_FIXTURES } from "@/server/mockFixtures";

/** Envelope every fixture file must follow (marks it as synthetic and states the expectation). */
const FixtureEnvelope = z.discriminatedUnion("kind", [
  z.object({
    _notice: z.string().startsWith("SYNTHETIC TEST DATA"),
    scenario: z.string().min(1),
    kind: z.enum(["response", "raw_model_output"]),
    expect: z.enum(["valid", "invalid"]),
    userLang: z.string(),
    storeLang: z.string(),
    selectedAllergens: z.array(AllergenCodeSchema).min(1),
    body: z.unknown(),
  }).strict(),
  z.object({
    _notice: z.string().startsWith("SYNTHETIC TEST DATA"),
    scenario: z.string().min(1),
    kind: z.literal("error"),
    expect: z.literal("valid"),
    httpStatus: z.number().int(),
    body: z.unknown(),
  }).strict(),
]);
type Fixture = z.infer<typeof FixtureEnvelope>;
const fixtures: [string, Fixture][] = Object.entries(MOCK_FIXTURES).map(([n, f]) => [n, FixtureEnvelope.parse(f)]);
const responseFixtures = fixtures.filter(([, f]) => f.kind === "response" && f.expect === "valid");

function clone<T>(v: T): T {
  return structuredClone(v);
}
function okBody(): AnalyzeMenuResponse {
  return AnalyzeMenuResponseSchema.parse(clone(MOCK_FIXTURES.ok.body));
}
function form(fields: Record<string, string | string[]>, image?: Blob | null): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  if (image) f.append("image", image);
  return f;
}
const jpeg = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });

describe("allergens", () => {
  it("defines exactly the 11 MVP allergen codes", () => {
    expect([...ALLERGEN_CODES].sort()).toEqual(
      ["buckwheat", "crab", "egg", "fish", "milk", "peanut", "sesame", "shrimp", "soy", "walnut", "wheat"],
    );
    for (const code of ALLERGEN_CODES) {
      expect(ALLERGENS[code].labels.ja.length).toBeGreaterThan(0);
      expect(ALLERGENS[code].labels.en.length).toBeGreaterThan(0);
    }
  });
  it("rejects unsupported codes (no vague 'other nuts' bucket)", () => {
    for (const bad of ["tree_nuts", "other_nuts", "almond", "shellfish", ""]) {
      expect(AllergenCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("keeps fish separate from shrimp/crab and documents its broad scope", () => {
    expect(ALLERGENS.fish.scopeNote?.ja).toContain("えび・かにとは別");
  });
});

describe("language pairs (MVP config, not a permanent rule)", () => {
  it("supports exactly ja->en and en->ja in the MVP config", () => {
    expect(SUPPORTED_LANGUAGE_PAIRS).toEqual([
      { userLang: "ja", storeLang: "en" },
      { userLang: "en", storeLang: "ja" },
    ]);
    expect(isSupportedLanguagePair("ja", "en")).toBe(true);
    expect(isSupportedLanguagePair("en", "ja")).toBe(true);
    expect(isSupportedLanguagePair("ja", "fr")).toBe(false);
    expect(isSupportedLanguagePair("ja", "ja")).toBe(false);
  });
  it("does not hard-code 'languages must differ' into the schema", () => {
    // Same-language input is schema-valid; support is decided by the config only.
    expect(AnalyzeMenuFieldsSchema.safeParse({ userLang: "en", storeLang: "en", allergens: ["egg"] }).success).toBe(true);
    expect(isSupportedLanguagePair("en", "en", [{ userLang: "en", storeLang: "en" }])).toBe(true);
  });
});

describe("request contract", () => {
  const base = { userLang: "ja", storeLang: "en", allergens: ["peanut", "egg"] };

  it("accepts a valid request", () => {
    const r = parseAnalyzeMenuForm(form(base, jpeg()));
    expect(r.ok).toBe(true);
  });
  it.each([
    ["missing image", form(base, null), "image_missing"],
    ["empty image", form(base, jpeg(0)), "image_missing"],
    ["unsupported type", form(base, new Blob(["x"], { type: "image/gif" })), "unsupported_image_type"],
    ["too large", form(base, jpeg(IMAGE_CONSTRAINTS.maxBytes + 1)), "image_too_large"],
    ["unsupported pair", form({ ...base, storeLang: "fr" }, jpeg()), "unsupported_language_pair"],
    ["unknown allergen", form({ ...base, allergens: ["peanut", "tree_nuts"] }, jpeg()), "invalid_allergens"],
    ["no allergens", form({ userLang: "ja", storeLang: "en" }, jpeg()), "invalid_allergens"],
    ["duplicate allergens", form({ ...base, allergens: ["egg", "egg"] }, jpeg()), "invalid_allergens"],
    ["missing languages", form({ allergens: ["egg"] }, jpeg()), "malformed_request"],
    ["bad language tag", form({ ...base, userLang: "<script>" }, jpeg()), "malformed_request"],
  ])("rejects %s", (_name, f, reason) => {
    expect(parseAnalyzeMenuForm(f)).toEqual({ ok: false, reason });
  });
  it("rejects unknown request fields (schema)", () => {
    expect(AnalyzeMenuFieldsSchema.safeParse({ ...base, debug: true }).success).toBe(false);
  });

  // MINOR-1 (Codex PR1 audit): closed set of multipart fields, tested on parseAnalyzeMenuForm directly.
  it("documents the allowed multipart fields", () => {
    expect(ANALYZE_FORM_FIELDS).toEqual({ single: ["image", "userLang", "storeLang"], repeated: ["allergens"] });
  });
  it.each(["debug", "safe", "mockScenario", "$ACTION_ID_abc", "allergen", "Image"])(
    "parseAnalyzeMenuForm rejects an unknown form field '%s'",
    (key) => {
      const f = form(base, jpeg());
      f.append(key, "x");
      expect(parseAnalyzeMenuForm(f)).toEqual({ ok: false, reason: "malformed_request" });
    },
  );
  it.each(["userLang", "storeLang"])("parseAnalyzeMenuForm rejects a repeated single-value field '%s'", (key) => {
    const f = form(base, jpeg());
    f.append(key, "ja");
    expect(parseAnalyzeMenuForm(f)).toEqual({ ok: false, reason: "malformed_request" });
  });
  it("parseAnalyzeMenuForm rejects two images", () => {
    const f = form(base, jpeg());
    f.append("image", jpeg());
    expect(parseAnalyzeMenuForm(f)).toEqual({ ok: false, reason: "malformed_request" });
  });
  it("parseAnalyzeMenuForm accepts repeated allergens and returns the parsed fields", () => {
    const r = parseAnalyzeMenuForm(form({ ...base, allergens: ["peanut", "egg", "fish"] }, jpeg()));
    expect(r.ok && r.fields).toEqual({ userLang: "ja", storeLang: "en", allergens: ["peanut", "egg", "fish"] });
  });
});

describe("response contract: fixtures", () => {
  it.each(fixtures)("%s: every fixture is explicitly marked synthetic", (_n, f) => {
    expect(f._notice).toMatch(/^SYNTHETIC TEST DATA/);
  });

  it("includes every required scenario", () => {
    expect(Object.keys(MOCK_FIXTURES).sort()).toEqual(
      [
        "conflicting_assessments_raw",
        "cross_contact_notice",
        "error_ai_timeout",
        "injection_in_image",
        "invalid_output_raw",
        "invisible_evidence_raw",
        "negation_claims",
        "no_allergen_mentions",
        "ok",
        "partial",
        "unreadable",
      ],
    );
  });

  it.each(responseFixtures)("%s: valid response fixture passes schema and invariants", (_n, f) => {
    if (f.kind === "error") throw new Error("unreachable");
    const parsed = AnalyzeMenuResponseSchema.parse(f.body);
    expect(parsed.dataOrigin).toBe("mock_fixture");
    expect(checkResponseInvariants(parsed, f.selectedAllergens)).toEqual([]);
  });

  it("covers both MVP language pairs", () => {
    const pairs = new Set(responseFixtures.map(([, f]) => (f.kind === "error" ? "" : `${f.userLang}->${f.storeLang}`)));
    expect(pairs).toEqual(new Set(["ja->en", "en->ja"]));
  });

  it("rejects the invalid raw model output (safe/edible/allergen_absent)", () => {
    expect(AnalyzeMenuResponseSchema.safeParse(MOCK_FIXTURES.invalid_output_raw.body).success).toBe(false);
  });

  it("error fixture matches the error contract", () => {
    const f = MOCK_FIXTURES.error_ai_timeout;
    const e = AnalyzeMenuErrorSchema.parse(f.body);
    expect(ERROR_HTTP_STATUS[e.error.code]).toBe(f.httpStatus);
  });
});

describe("response contract: no safety verdicts", () => {
  it.each(["safe", "edible", "allergen_absent", "isSafe", "canEat", "verdict"])(
    "rejects a '%s' field on items",
    (key) => {
      const body = clone(okBody()) as unknown as { items: Record<string, unknown>[] };
      body.items[0]![key] = true;
      expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);
    },
  );
  it("rejects a safety field on an assessment and at the top level", () => {
    const a = clone(okBody()) as unknown as { items: { allergens: Record<string, unknown>[] }[] };
    a.items[0]!.allergens[0]!.safe = true;
    expect(AnalyzeMenuResponseSchema.safeParse(a).success).toBe(false);
    expect(AnalyzeMenuResponseSchema.safeParse({ ...okBody(), safe: true }).success).toBe(false);
  });
  it("rejects categories other than the three defined ones", () => {
    for (const category of ["allergen_absent", "safe", "not_contained", "verified"]) {
      const body = clone(okBody()) as unknown as { items: { allergens: Record<string, unknown>[] }[] };
      body.items[0]!.allergens[0] = { code: "shrimp", category, confirmationRequired: true };
      expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);
    }
  });
  it("requires confirmationRequired: true in every category", () => {
    const body = clone(okBody()) as unknown as { items: { allergens: Record<string, unknown>[] }[] };
    body.items[0]!.allergens[3]!.confirmationRequired = false;
    expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);
  });
  it("marks read text as AI-read and translations as unverified (cannot be claimed verified)", () => {
    const body = clone(okBody()) as unknown as { items: { readText: { readBy: string }; aiTranslation: { verified: boolean } }[] };
    body.items[0]!.readText.readBy = "human";
    expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);
    const body2 = clone(okBody()) as unknown as { items: { aiTranslation: { verified: boolean } }[] };
    body2.items[0]!.aiTranslation.verified = true;
    expect(AnalyzeMenuResponseSchema.safeParse(body2).success).toBe(false);
  });
  it("rejects unknown data origins", () => {
    expect(AnalyzeMenuResponseSchema.safeParse({ ...okBody(), dataOrigin: "verified" }).success).toBe(false);
  });
});

describe("three categories stay distinct", () => {
  it("menu_mentions requires a mention (kind + excerpt); others must not carry one", () => {
    const body = clone(okBody()) as unknown as { items: { allergens: Record<string, unknown>[] }[] };
    delete body.items[0]!.allergens[0]!.mention;
    expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);

    const body2 = clone(okBody()) as unknown as { items: { allergens: Record<string, unknown>[] }[] };
    body2.items[0]!.allergens[3]!.mention = { kind: "contains_claim", excerpt: "x" };
    expect(AnalyzeMenuResponseSchema.safeParse(body2).success).toBe(false);
  });
  it("unconfirmed requires a reason", () => {
    const body = clone(okBody()) as unknown as { items: { allergens: Record<string, unknown>[] }[] };
    delete body.items[0]!.allergens[3]!.reason;
    expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("negations and precautionary statements", () => {
  const items = MOCK_FIXTURES.negation_claims.body.items;
  const kindOf = (id: string) => {
    const a = items.find((i) => i.id === id)!.allergens[0]!;
    return a.category === "menu_mentions" && "mention" in a ? a.mention.kind : undefined;
  };
  it("distinguishes contains / absence / possible presence", () => {
    expect(kindOf("item-1")).toBe("contains_claim"); // contains peanuts
    expect(kindOf("item-2")).toBe("absence_claim"); // peanut-free
    expect(kindOf("item-3")).toBe("possible_presence"); // may contain peanuts
    expect(kindOf("item-4")).toBe("absence_claim"); // no peanuts added
    expect(kindOf("item-5")).toBe("possible_presence"); // facility handling peanuts
  });
  it("an absence claim is still a menu mention that requires confirmation (not a verdict)", () => {
    const parsed = AnalyzeMenuResponseSchema.parse(MOCK_FIXTURES.negation_claims.body);
    for (const item of parsed.items) {
      for (const a of item.allergens) {
        expect(a.category).toBe("menu_mentions");
        expect(a.confirmationRequired).toBe(true);
      }
    }
  });
  it("rejects unknown mention kinds", () => {
    const body = clone(okBody()) as unknown as { items: { allergens: { mention?: { kind: string } }[] }[] };
    body.items[0]!.allergens[0]!.mention!.kind = "verified_absent";
    expect(AnalyzeMenuResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("cross-field invariants", () => {
  const selected: AllergenCode[] = ["shrimp", "wheat", "egg", "milk"];

  it("flags a missing selected allergen", () => {
    const body = okBody();
    body.items[0]!.allergens = body.items[0]!.allergens.filter((a) => a.code !== "milk");
    expect(checkResponseInvariants(body, selected)).toContainEqual(
      expect.objectContaining({ message: "missing assessment for milk" }),
    );
  });
  it("flags unselected and duplicate assessments", () => {
    const body = okBody();
    body.items[0]!.allergens.push({ code: "peanut", category: "unconfirmed", reason: "not_mentioned", confirmationRequired: true });
    body.items[0]!.allergens.push({ code: "milk", category: "unconfirmed", reason: "not_mentioned", confirmationRequired: true });
    const msgs = checkResponseInvariants(body, selected).map((v) => v.message);
    expect(msgs).toContain("allergen peanut was not selected");
    expect(msgs).toContain("duplicate assessment for milk");
  });
  it("flags an excerpt that is not in the AI-read text (consistency only)", () => {
    const body = okBody();
    const a = body.items[0]!.allergens[0]!;
    if (a.category !== "menu_mentions") throw new Error("fixture changed");
    a.mention.excerpt = "lobster";
    expect(checkResponseInvariants(body, selected)).toContainEqual(
      expect.objectContaining({ message: "excerpt does not appear in readText" }),
    );
  });
  it("flags inconsistent status", () => {
    expect(checkResponseInvariants({ ...okBody(), status: "unreadable" }, selected).length).toBeGreaterThan(0);
    expect(checkResponseInvariants({ ...okBody(), items: [] }, selected).length).toBeGreaterThan(0);
  });
});

// MAJOR-1 (Codex PR1 audit): duplicates/conflicts must be detected BEFORE any
// alignment, and must never be resolved by silently keeping one of them.
describe("duplicate and conflicting assessments (detected before projection)", () => {
  type A = AnalyzeMenuResponse["items"][number]["allergens"][number];
  const contains: A = { code: "peanut", category: "menu_mentions", mention: { kind: "contains_claim", excerpt: "peanut sauce" }, confirmationRequired: true };
  const absence: A = { code: "peanut", category: "menu_mentions", mention: { kind: "absence_claim", excerpt: "peanut-free" }, confirmationRequired: true };
  const unconfirmed: A = { code: "peanut", category: "unconfirmed", reason: "not_mentioned", confirmationRequired: true };
  const inferred: A = { code: "peanut", category: "ai_inferred", rationale: null, confirmationRequired: true };

  function withAllergens(allergens: A[]): AnalyzeMenuResponse {
    return AnalyzeMenuResponseSchema.parse({
      requestId: "r",
      status: "ok",
      dataOrigin: "mock_fixture",
      imageIssues: [],
      items: [
        {
          id: "item-1",
          readText: { text: "Satay with peanut sauce (peanut-free option)", lang: "en", readBy: "ai" },
          aiTranslation: null,
          readability: "clear",
          allergens,
        },
      ],
      menuNotices: [],
    });
  }
  const messages = (r: AnalyzeMenuResponse) => findIntegrityViolations(r).map((v) => v.message);

  it("detects an identical duplicate", () => {
    expect(messages(withAllergens([contains, contains]))).toContain("duplicate assessment for peanut");
  });
  it.each([
    ["unconfirmed first, then contains", [unconfirmed, contains]],
    ["contains first, then unconfirmed", [contains, unconfirmed]],
  ])("detects unconfirmed vs contains conflict regardless of order (%s)", (_n, list) => {
    const r = withAllergens(list as A[]);
    expect(messages(r)).toContain("conflicting assessments for peanut: menu_mentions:contains_claim vs unconfirmed");
    const p = projectToSelectedAllergens(r, ["peanut"]);
    expect(p.ok).toBe(false); // the contains mention is never replaced by "unconfirmed"
  });
  it.each([
    ["contains first", [contains, absence]],
    ["absence first", [absence, contains]],
  ])("detects contains_claim vs absence_claim conflict (%s)", (_n, list) => {
    const r = withAllergens(list as A[]);
    expect(messages(r)).toContain("conflicting assessments for peanut: menu_mentions:absence_claim vs menu_mentions:contains_claim");
    expect(projectToSelectedAllergens(r, ["peanut"]).ok).toBe(false);
  });
  it("detects ai_inferred vs unconfirmed conflict", () => {
    expect(messages(withAllergens([inferred, unconfirmed]))).toContain(
      "conflicting assessments for peanut: ai_inferred vs unconfirmed",
    );
  });
  it("projection refuses duplicates even for allergens the user did not select (no silent discard)", () => {
    const r = withAllergens([contains, unconfirmed]);
    const p = projectToSelectedAllergens(r, ["milk"]);
    expect(p.ok).toBe(false);
  });
  it("fillMissingAsUnconfirmed only appends and never removes duplicates", () => {
    const [item] = fillMissingAsUnconfirmed(withAllergens([contains, unconfirmed]).items, ["peanut", "egg"]);
    expect(item!.allergens).toEqual([
      contains,
      unconfirmed,
      { code: "egg", category: "unconfirmed", reason: "not_assessed", confirmationRequired: true },
    ]);
  });
  it("detects duplicate/conflicting mentions in menu notices", () => {
    const r = AnalyzeMenuResponseSchema.parse({
      ...MOCK_FIXTURES.cross_contact_notice.body,
      menuNotices: [
        {
          ...MOCK_FIXTURES.cross_contact_notice.body.menuNotices[0],
          mentions: [
            { code: "shrimp", kind: "possible_presence" },
            { code: "shrimp", kind: "absence_claim" },
          ],
        },
      ],
    });
    const m = findIntegrityViolations(r).map((v) => v.message);
    expect(m).toContain("duplicate mention for shrimp");
    expect(m).toContain("conflicting mentions for shrimp: absence_claim vs possible_presence");
  });
  it("the conflicting raw fixture is schema-valid but fails integrity", () => {
    const f = MOCK_FIXTURES.conflicting_assessments_raw;
    const parsed = AnalyzeMenuResponseSchema.parse(f.body);
    expect(findIntegrityViolations(parsed).length).toBeGreaterThan(0);
    expect(projectToSelectedAllergens(parsed, f.selectedAllergens as AllergenCode[]).ok).toBe(false);
  });
});

describe("projection to the selected allergens (valid input)", () => {
  it("fills missing as unconfirmed/not_assessed, drops unselected with a report, keeps selection order", () => {
    const body = okBody();
    const p = projectToSelectedAllergens(body, ["peanut", "shrimp"]);
    if (!p.ok) throw new Error(JSON.stringify(p.violations));
    for (const item of p.response.items) {
      expect(item.allergens.map((a) => a.code)).toEqual(["peanut", "shrimp"]);
      expect(item.allergens[0]).toEqual({ code: "peanut", category: "unconfirmed", reason: "not_assessed", confirmationRequired: true });
    }
    expect(p.droppedUnselected.map((d) => d.code).sort()).toEqual(
      ["egg", "egg", "egg", "milk", "milk", "milk", "wheat", "wheat", "wheat"],
    );
    expect(checkResponseInvariants(p.response, ["peanut", "shrimp"])).toEqual([]);
  });
  it("regression: a normal response projected onto its own selection is unchanged", () => {
    const body = okBody();
    const p = projectToSelectedAllergens(body, ["shrimp", "wheat", "egg", "milk"]);
    if (!p.ok) throw new Error(JSON.stringify(p.violations));
    expect(p.response).toEqual(body);
    expect(p.droppedUnselected).toEqual([]);
  });
  it("keeps the contains mention of a selected allergen intact", () => {
    const p = projectToSelectedAllergens(okBody(), ["shrimp"]);
    if (!p.ok) throw new Error("unexpected");
    expect(p.response.items[0]!.allergens).toEqual([
      { code: "shrimp", category: "menu_mentions", mention: { kind: "contains_claim", excerpt: "Shrimp" }, confirmationRequired: true },
    ]);
  });
});

// MAJOR-2 (Codex PR1 audit): blank excerpts must not pass schema or the match check.
describe("blank AI text / excerpts are rejected", () => {
  function withExcerpt(excerpt: string) {
    const body = clone(okBody()) as unknown as { items: { allergens: { mention?: { excerpt: string } }[] }[] };
    body.items[0]!.allergens[0]!.mention!.excerpt = excerpt;
    return AnalyzeMenuResponseSchema.safeParse(body);
  }
  it.each([
    ["half-width spaces", "   "],
    ["full-width spaces", "\u3000\u3000"],
    ["newlines", "\n\n"],
    ["tabs", "\t\t"],
    ["mixed whitespace", " \u3000\n\t "],
    ["zero-width space", "\u200B"],
  ])("rejects an excerpt of only %s", (_n, excerpt) => {
    expect(normalizeForMatch(excerpt)).toBe("");
    expect(withExcerpt(excerpt).success).toBe(false);
  });
  it("accepts a normal excerpt, including surrounding/full-width spaces", () => {
    expect(withExcerpt("Shrimp").success).toBe(true);
    expect(withExcerpt("\u3000Shrimp ").success).toBe(true);
  });
  it("rejects blank readText and blank translations too", () => {
    const b1 = clone(okBody()) as unknown as { items: { readText: { text: string } }[] };
    b1.items[0]!.readText.text = "\u3000 \n";
    expect(AnalyzeMenuResponseSchema.safeParse(b1).success).toBe(false);
    const b2 = clone(okBody()) as unknown as { items: { aiTranslation: { text: string } }[] };
    b2.items[0]!.aiTranslation.text = "\t";
    expect(AnalyzeMenuResponseSchema.safeParse(b2).success).toBe(false);
  });
  it("matching still works across width/case/whitespace differences (consistency only)", () => {
    expect(normalizeForMatch("Ｓｈｒｉｍｐ\u3000 Tempura")).toBe("shrimp tempura");
  });
});

describe("error contract", () => {
  it("every error code has an HTTP status and fixed retryable flag", () => {
    for (const code of ErrorCodeSchema.options) {
      const e = makeError("r1", code);
      expect(AnalyzeMenuErrorSchema.parse(e).error.retryable).toBe(ERROR_RETRYABLE[code]);
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
  it("rejects a mismatched retryable flag, a reason on non-input errors, and unknown codes", () => {
    expect(AnalyzeMenuErrorSchema.safeParse({ requestId: "r", error: { code: "AI_DISABLED", retryable: true } }).success).toBe(false);
    expect(
      AnalyzeMenuErrorSchema.safeParse({ requestId: "r", error: { code: "AI_FAILED", retryable: true, reason: "image_missing" } }).success,
    ).toBe(false);
    expect(AnalyzeMenuErrorSchema.safeParse({ requestId: "r", error: { code: "UNSAFE", retryable: false } }).success).toBe(false);
  });
});

/*
 * Responsibility boundary: the items below belong to PR2 (server pipeline with
 * Gemini on Vertex AI). They are registered as TODO so they are reported as
 * not implemented — they are NOT passing tests.
 */
describe("PR2 responsibilities (not implemented in PR1)", () => {
  it.todo("validates real Gemini structured output with the contract and retries once before AI_FAILED");
  it.todo("downgrades or rejects menu_mentions whose excerpt is not in readText (policy decided in PR2)");
  it.todo("prompt instructs the model that text inside the image is data, never instructions");
  it.todo("live evaluation: injection image does not produce safety claims (manual, recorded in VALIDATION.md)");
  it.todo("classifies negations/precautionary statements correctly on real model output (manual eval set)");
  it.todo("logs never contain image bytes or AI output text");
  it.todo("maps Gemini timeouts / quota / unavailability to AI_TIMEOUT / RATE_LIMITED / AI_FAILED");
});
