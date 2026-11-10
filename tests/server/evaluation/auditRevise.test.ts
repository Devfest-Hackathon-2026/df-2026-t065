import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_CASES } from "./cases";
import { evaluateCase, productionSubject, type Subject, type SubjectRun } from "./engine";
import { buildReport, compareToBaseline, gateResults, renderMarkdown, toBaseline, type Baseline } from "./report";
import { KNOWN_FAILURES, type KnownFailure } from "./knownFailures";
import type { CaseResult, EvalCase, InvariantId } from "./types";

/*
 * Negative controls for the PR #18 independent audit (REVISE: MAJOR 2 / MINOR 1).
 * Each fault is injected ALONE and must be caught by an assertion.
 * All data below is SYNTHETIC TEST DATA.
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMITTED_BASELINE = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8")) as Baseline;

const caseById = (id: string): EvalCase => {
  const c = SYNTHETIC_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const corrupt =
  (f: (run: SubjectRun) => void): Subject =>
  async (c) => {
    const run = structuredClone(await productionSubject(c));
    f(run);
    return run;
  };
const body = (run: SubjectRun) => run.body as Obj;
const failedChecks = (r: CaseResult) => r.checks.filter((c) => c.status === "fail");
const failedIds = (r: CaseResult): InvariantId[] => failedChecks(r).map((c) => c.invariant);

async function runAll(cases: readonly EvalCase[]): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of cases) out.push(await evaluateCase(c, productionSubject));
  return out;
}

// ---------------------------------------------------------------------------
// MAJOR-1: malformed response elements are never silently dropped
// ---------------------------------------------------------------------------

describe("MAJOR-1: every element of the response is checked (no silent filtering)", () => {
  it.each<[string, string, (r: SubjectRun) => void, RegExp]>([
    ["items.push(null)", "EV-001", (r) => void body(r).items.push(null), /items\[1\]: expected item object, got null/],
    ["null inside an allergens array", "EV-001", (r) => void body(r).items[0].allergens.push(null), /items\[0\]\.allergens\[3\]: expected assessment object, got null/],
    ["translation of object type", "EV-001", (r) => void (body(r).items[0].aiTranslation.text = { value: "x" }), /items\[0\]\.aiTranslation\.text: expected string, got object/],
    ["translation that is an object of the wrong shape", "EV-001", (r) => void (body(r).items[0].aiTranslation = { note: "x" }), /items\[0\]\.aiTranslation: missing required key text/],
    ["invalid readability", "EV-001", (r) => void (body(r).items[0].readability = "fully_readable"), /items\[0\]\.readability: value outside the enum/],
    ["missing required field", "EV-001", (r) => void delete body(r).items[0].readability, /items\[0\]: missing required key readability/],
    ["unknown mention kind", "EV-001", (r) => void (body(r).items[0].allergens[0].mention.kind = "definitely_absent"), /mention\.kind: value outside the enum/],
    ["unknown status", "EV-001", (r) => void (body(r).status = "complete"), /\$\.status: value outside the enum/],
    ["unknown image issue", "EV-016", (r) => void body(r).imageIssues.push("glare"), /\$\.imageIssues\[1\]: value outside the enum/],
    ["null notice", "EV-005", (r) => void body(r).menuNotices.push(null), /menuNotices\[1\]: expected notice object, got null/],
    ["extra nested key", "EV-001", (r) => void (body(r).items[0].readText.meta = { a: 1 }), /items\[0\]\.readText: 1 unexpected key\(s\)/],
    ["readText.text of number type", "EV-001", (r) => void (body(r).items[0].readText.text = 42), /readText\.text: expected string, got number/],
  ])("detects: %s", async (_name, id, fault, detail) => {
    // positive control first: the unmodified subject passes the structure check
    const clean = await evaluateCase(caseById(id), productionSubject);
    expect(clean.checks.find((c) => c.invariant === "INV-STRUCTURE")!.status).toBe("pass");

    const r = await evaluateCase(caseById(id), corrupt(fault));
    expect(r.status).toBe("fail");
    const structure = r.checks.find((c) => c.invariant === "INV-STRUCTURE")!;
    expect(structure.status).toBe("fail");
    expect(structure.detail).toMatch(detail);
  });

  it("a null dish is also a coverage failure (it is not a valid dish entry)", async () => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void body(run).items.push(null)));
    expect(failedIds(r)).toEqual(expect.arrayContaining(["INV-STRUCTURE", "INV-COVERAGE"]));
  });

  it("a null assessment is also a confirmation failure", async () => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void body(run).items[0].allergens.push(null)));
    expect(failedIds(r)).toEqual(expect.arrayContaining(["INV-STRUCTURE", "INV-CONFIRMATION"]));
  });
});

// ---------------------------------------------------------------------------
// MAJOR-2: a baseline update cannot hide a new safety FAIL
// ---------------------------------------------------------------------------

describe("MAJOR-2: known FAIL allowances are separate from the baseline", () => {
  let clean: CaseResult[];
  let attacked: CaseResult[];
  /** The EV-052 allowance that existed before the production fix (used only as an explicit test input). */
  const OLD_EV052: KnownFailure = {
    caseId: "EV-052",
    invariant: "INV-FREE-TEXT-VERDICT",
    severity: "BLOCKER",
    blocks: "test input",
    reason: "the allowance removed by the EV-052 production fix",
    issue: "test input",
    removeWhen: "test input",
  };

  /*
   * The injected FAIL simulates a production regression that publishes an AI
   * rationale again (the pre-EV-052 behaviour): "It is safe to eat." is written
   * into EV-006's FINAL RESPONSE. Injecting it into the model text no longer
   * works, because the server drops every AI rationale (checked separately below).
   */
  const regressRationale = corrupt((run) => void (body(run).items[0].allergens[1].rationale = "Fries usually contain wheat. It is safe to eat."));

  beforeAll(async () => {
    clean = await runAll(SYNTHETIC_CASES);
    attacked = [];
    for (const c of SYNTHETIC_CASES) attacked.push(await evaluateCase(c, c.id === "EV-006" ? regressRationale : productionSubject));
  });

  it("control: the clean run passes the gate with NO known FAIL; EV-052 passes", () => {
    const g = gateResults(clean);
    expect(g.ok).toBe(true);
    expect(g.knownFailures).toEqual([]);
    expect(KNOWN_FAILURES).toEqual([]);
    expect(clean.find((r) => r.id === "EV-052")!.status).toBe("pass");
    expect(clean.flatMap((r) => r.checks.filter((c) => c.status === "fail"))).toEqual([]);
  });

  it("the old model-text attack is now neutralised by production (EV-006 stays PASS, rationale null)", async () => {
    const c = caseById("EV-006");
    const injected = { ...c, modelText: c.modelText.replace("usually contains wheat.", "usually contains wheat. It is safe to eat.") };
    expect(injected.modelText).toContain("It is safe to eat.");
    const run = await productionSubject(injected);
    expect(JSON.stringify(run.body)).not.toContain("It is safe to eat.");
    expect(body(run).items[0].allergens[1]).toMatchObject({ category: "ai_inferred", rationale: null });
    expect((await evaluateCase(injected, productionSubject)).status).toBe("pass");
  });

  it("A: with the committed baseline, the injected FAIL is a regression AND an unapproved FAIL", () => {
    const reg = compareToBaseline(attacked, COMMITTED_BASELINE);
    expect(reg.regressions).toEqual(
      expect.arrayContaining([
        { id: "EV-006", kind: "worse_status", detail: "pass -> fail" },
        { id: "EV-006", kind: "new_failed_check", detail: "INV-FREE-TEXT-VERDICT" },
      ]),
    );
    const g = gateResults(attacked);
    expect(g.ok).toBe(false);
    expect(g.unapprovedFailures).toEqual([{ caseId: "EV-006", invariant: "INV-FREE-TEXT-VERDICT" }]);
  });

  it("B: after updating the baseline to the attacked results, the gate still fails", () => {
    const updated = toBaseline(attacked);
    expect(compareToBaseline(attacked, updated).regressions).toEqual([]); // the baseline alone is fooled …
    const g = gateResults(attacked); // … the gate does not read the baseline at all
    expect(g.ok).toBe(false);
    expect(g.unapprovedFailures).toEqual([{ caseId: "EV-006", invariant: "INV-FREE-TEXT-VERDICT" }]);
    const report = buildReport(attacked, SYNTHETIC_CASES, { baseline: updated, networkCalls: 0, target: { commitSha: "unknown", workingTreeDirty: "unknown" } });
    expect(report.gate.ok).toBe(false);
    const md = renderMarkdown(report);
    expect(md).toContain("**未承認の新規FAIL: 1 件**");
    expect(md).toContain("| EV-006 | FAIL（未承認）");
    expect(md).not.toContain("FAIL（既知・BLOCKER）");
  });

  it("B2: the pre-fix behaviour on EV-052 itself is an UNAPPROVED FAIL now that the allowance is gone", async () => {
    const regressed = await evaluateCase(
      caseById("EV-052"),
      corrupt((run) => void (body(run).items[0].allergens[0].rationale = "Fruit tarts rarely use peanuts, so it is safe for peanut allergies.")),
    );
    expect(regressed.status).toBe("fail");
    const rs = clean.map((r) => (r.id === "EV-052" ? regressed : r));
    const g = gateResults(rs);
    expect(g.ok).toBe(false);
    expect(g.unapprovedFailures).toEqual([{ caseId: "EV-052", invariant: "INV-FREE-TEXT-VERDICT" }]);
    expect(g.knownFailures).toEqual([]);
  });

  it("C: an explicit allowance only covers its exact (case, invariant) pair", () => {
    const g = gateResults(attacked, { knownFailures: [OLD_EV052] });
    expect(g.unapprovedFailures).toEqual([{ caseId: "EV-006", invariant: "INV-FREE-TEXT-VERDICT" }]); // same invariant, other case: not covered
    const fake: CaseResult[] = clean.map((r) =>
      r.id === "EV-052"
        ? { ...r, checks: r.checks.map((c) => (c.invariant === "INV-CONFIRMATION" ? { ...c, status: "fail" as const, detail: "injected" } : c)) }
        : r,
    );
    expect(gateResults(fake, { knownFailures: [OLD_EV052] }).unapprovedFailures).toEqual([{ caseId: "EV-052", invariant: "INV-CONFIRMATION" }]); // other invariant: not covered
  });

  it("D: the 4 unverified cases stay unverified and may not turn into PASS", () => {
    for (const id of ["EV-019", "EV-041", "EV-043", "EV-044"]) expect(clean.find((r) => r.id === id)!.status).toBe("unverified");
    // Removing the declared undecidable statement of EV-041 would make it PASS: the gate rejects that.
    const cases = SYNTHETIC_CASES.map((c) => (c.id === "EV-041" ? { ...c, unverifiable: [] } : c));
    return runAll(cases).then((rs) => {
      expect(rs.find((r) => r.id === "EV-041")!.status).toBe("pass");
      const g = gateResults(rs);
      expect(g.ok).toBe(false);
      expect(g.declaredNotUnverified).toEqual(["EV-041"]);
    });
  });

  it("stale: an allowance whose case no longer fails is reported as stale (the situation EV-052 is in now)", () => {
    const g = gateResults(clean, { knownFailures: [OLD_EV052] });
    expect(g.ok).toBe(false);
    expect(g.staleAllowances).toEqual([{ caseId: "EV-052", invariant: "INV-FREE-TEXT-VERDICT" }]);
  });

  it("duplicate allowances and undeclared unverified cases are rejected", () => {
    expect(gateResults(clean, { knownFailures: [OLD_EV052, OLD_EV052] }).duplicateAllowances).toHaveLength(1);
    expect(gateResults(clean, { declaredUnverified: [] }).undeclaredUnverified).toEqual(["EV-019", "EV-041", "EV-043", "EV-044"]);
  });
});

// ---------------------------------------------------------------------------
// MINOR-1: no arbitrary strings reach the report
// ---------------------------------------------------------------------------

describe("MINOR-1: unknown key names, enum values and log values never reach the report", () => {
  const MARK = "ZQXLEAKMARK7";

  it.each<[string, string, (r: SubjectRun) => void]>([
    ["unknown key name in a dish", "EV-001", (r) => void (body(r).items[0][`${MARK}_key`] = 1)],
    ["unknown verdict-like key name", "EV-001", (r) => void (body(r).items[0].allergens[0][`safe_${MARK}`] = true)],
    ["unknown top-level key name with a nested verdict key", "EV-001", (r) => void (body(r)[`${MARK}_top`] = { [`${MARK}_nested`]: { safe: true } })],
    ["unknown enum values", "EV-001", (r) => {
      body(r).items[0].readability = `${MARK}_readability`;
      body(r).items[0].allergens[0].mention.kind = `${MARK}_kind`;
      body(r).items[0].allergens[2].reason = `${MARK}_reason`;
      body(r).status = `${MARK}_status`;
    }],
    ["unknown allergen code", "EV-001", (r) => void (body(r).items[0].allergens[0].code = `${MARK}_code`)],
    ["unknown category", "EV-001", (r) => void (body(r).items[0].allergens[1].category = `${MARK}_cat`)],
    ["logger failure value", "EV-035", (r) => void r.logs.push({ event: "analyze_menu", failure: `${MARK}_failure` })],
    ["unknown error code and extra error key", "EV-035", (r) => {
      body(r).error.code = `${MARK}_errcode`;
      body(r).error[`${MARK}_errkey`] = "x";
      body(r).error.reason = `${MARK}_reason`;
    }],
    ["readBy / verified values", "EV-001", (r) => {
      body(r).items[0].readText.readBy = `${MARK}_reader`;
      body(r).items[0].aiTranslation.verified = `${MARK}_verified`;
    }],
  ])("%s", async (_name, id, fault) => {
    const r = await evaluateCase(caseById(id), corrupt(fault));
    expect(r.status).toBe("fail"); // the fault is still detected …
    const report = buildReport([r], [caseById(id)], { networkCalls: 0, target: { commitSha: "unknown", workingTreeDirty: "unknown" } });
    const json = JSON.stringify(report);
    const md = renderMarkdown(report);
    expect(json).not.toContain(MARK); // … but its text is not copied
    expect(md).not.toContain(MARK);
  });

  it("a verdict key under an unknown key is still reported, with a placeholder path", async () => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void (body(run)[`${MARK}_top`] = { safe: true })));
    expect(r.checks.find((c) => c.invariant === "INV-NO-VERDICT")!.detail).toContain("verdict-like key under $.<unknown-key>");
  });

  it("an unknown logged failure is reported as a fixed code", async () => {
    const r = await evaluateCase(caseById("EV-035"), corrupt((run) => void run.logs.push({ event: "analyze_menu", failure: `${MARK}_failure` })));
    expect(r.observed.failure).toBe("unrecognized_failure");
  });
});

// ---------------------------------------------------------------------------
// Re-audit (CONDITIONAL GO) MINOR-1: an unknown logged failure alone is a FAIL
// ---------------------------------------------------------------------------

describe("re-audit MINOR-1: unknown log failure values are an independent violation", () => {
  const MARK = "ZQXLOGMARK3";

  it("control: EV-001 is fully clean", async () => {
    const r = await evaluateCase(caseById("EV-001"), productionSubject);
    expect(r.status).toBe("pass");
    expect(failedChecks(r)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["unknown string", `${MARK}_failure`],
    ["number", 42],
    ["object", { why: MARK }],
    ["empty string", ""],
  ])("EV-001 + only a log failure of %s → FAIL on INV-LOG-VOCABULARY alone, value not reported", async (_n, value) => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void run.logs.push({ event: "analyze_menu", failure: value })));
    expect(r.status).toBe("fail");
    expect(failedIds(r)).toEqual(["INV-LOG-VOCABULARY"]); // nothing else is wrong
    const report = buildReport([r], [caseById("EV-001")], { networkCalls: 0, target: { commitSha: "unknown", workingTreeDirty: "unknown" } });
    expect(JSON.stringify(report)).not.toContain(MARK);
    expect(renderMarkdown(report)).not.toContain(MARK);
  });

  it("does not flag known fixed failure codes", async () => {
    const { KNOWN_FAILURE_CODES } = await import("./engine");
    const r = await evaluateCase(
      caseById("EV-001"),
      corrupt((run) => {
        for (const code of KNOWN_FAILURE_CODES) run.logs.push({ event: "analyze_menu", failure: code });
      }),
    );
    expect(r.checks.find((c) => c.invariant === "INV-LOG-VOCABULARY")!.status).toBe("pass");
    expect(r.status).toBe("pass");
  });

  it("does not flag the real failures logged for the 52 synthetic cases", async () => {
    for (const c of SYNTHETIC_CASES) {
      const r = await evaluateCase(c, productionSubject);
      expect(r.checks.find((x) => x.invariant === "INV-LOG-VOCABULARY")!.status, c.id).toBe("pass");
    }
  });
});

// ---------------------------------------------------------------------------
// Re-audit MINOR-2: language tags are validated independently
// ---------------------------------------------------------------------------

describe("re-audit MINOR-2: language tag grammar (independent of the contract regex)", () => {
  const VALID = ["ja", "en", "fil", "en-US", "zh-Hant", "zh-Hant-TW", "es-419", "sr-Latn-RS", "de-1996"];
  const INVALID: unknown[] = ["", "EN", "Ja", "e", "english", "en_US", "en-", "-en", "en--US", "en-x", "en-abcdefghi", "en US", "ja;DROP", "<b>", "ｊａ", "ja​", 42, true, {}, [], undefined];

  it("matches the public contract's grammar on a corpus (differential check; the evaluator does not use the contract)", async () => {
    const { isContractLanguageTag } = await import("./engine");
    const { LanguageTagSchema } = await import("@/contracts/analyze");
    for (const v of [...VALID, ...INVALID]) {
      expect(isContractLanguageTag(v), JSON.stringify(v) ?? String(v)).toBe(LanguageTagSchema.safeParse(v).success);
    }
  });

  it.each([...VALID.map((v) => [v] as [unknown]), [null] as [unknown]])("readText.lang %j is accepted (null allowed)", async (v) => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void (body(run).items[0].readText.lang = v)));
    expect(r.status).toBe("pass");
  });

  it.each(INVALID.filter((v) => v !== undefined).map((v) => [v] as [unknown]))("readText.lang %j → INV-STRUCTURE FAIL only", async (v) => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void (body(run).items[0].readText.lang = v)));
    expect(failedIds(r)).toEqual(["INV-STRUCTURE"]);
    expect(r.checks.find((c) => c.invariant === "INV-STRUCTURE")!.detail).toMatch(/items\[0\]\.readText\.lang: not a valid language tag or null/);
  });

  it("a missing readText.lang is a missing required key", async () => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void delete body(run).items[0].readText.lang));
    expect(r.checks.find((c) => c.invariant === "INV-STRUCTURE")!.detail).toMatch(/readText: missing required key lang/);
  });

  it.each<[unknown]>([[null], ["ja_JP"], [""], [7]])("aiTranslation.lang %j (not nullable) → INV-STRUCTURE FAIL", async (v) => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void (body(run).items[0].aiTranslation.lang = v)));
    expect(failedIds(r)).toContain("INV-STRUCTURE");
    expect(r.checks.find((c) => c.invariant === "INV-STRUCTURE")!.detail).toMatch(/aiTranslation\.lang: not a valid language tag/);
  });

  it("notice readText.lang is checked too", async () => {
    const r = await evaluateCase(caseById("EV-005"), corrupt((run) => void (body(run).menuNotices[0].readText.lang = "en__")));
    expect(failedIds(r)).toEqual(["INV-STRUCTURE"]);
  });

  it("invalid tag values are not copied into the report", async () => {
    const r = await evaluateCase(caseById("EV-001"), corrupt((run) => void (body(run).items[0].readText.lang = "ZQXLANGMARK9")));
    const report = buildReport([r], [caseById("EV-001")], { networkCalls: 0, target: { commitSha: "unknown", workingTreeDirty: "unknown" } });
    expect(JSON.stringify(report)).not.toContain("ZQXLANGMARK9");
    expect(renderMarkdown(report)).not.toContain("ZQXLANGMARK9");
  });
});

// ---------------------------------------------------------------------------
// EV-052: the evaluator's independent log vocabulary knows the new fail-closed code
// ---------------------------------------------------------------------------

describe("EV-052: log vocabulary for the final rationale check", () => {
  const logVocab = (r: CaseResult) => r.checks.find((c) => c.invariant === "INV-LOG-VOCABULARY")!;

  it("a logged ai_rationale_not_redacted is a known fixed code (not an unknown failure)", async () => {
    const r = await evaluateCase(caseById("EV-035"), corrupt((run) => void ((run.logs as Obj[])[0]!.failure = "ai_rationale_not_redacted")));
    expect(logVocab(r).status).toBe("pass");
  });

  it("NEGATIVE CONTROL: a similar but unknown code is still a vocabulary FAIL", async () => {
    const r = await evaluateCase(caseById("EV-035"), corrupt((run) => void ((run.logs as Obj[])[0]!.failure = "ai_rationale_not_redacted_x")));
    expect(logVocab(r).status).toBe("fail");
  });
});
