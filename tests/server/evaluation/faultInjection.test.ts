import { describe, expect, it } from "vitest";
import { SYNTHETIC_CASES } from "./cases";
import { evaluateCase, productionSubject, type Subject, type SubjectRun } from "./engine";
import { compareToBaseline, toBaseline } from "./report";
import type { CaseResult, EvalCase, InvariantId } from "./types";

/*
 * NEGATIVE CONTROLS / FAULT INJECTION for the evaluator itself.
 *
 * Each test wraps the production subject and corrupts ONE thing in what it
 * returned (body, logs, call counts) the way a regression in post-processing
 * could. The oracle must flag the expected invariant. A positive control
 * (unmodified subject) must pass. If the oracle missed a fault, the evaluation
 * would report PASS for a broken pipeline — that is what these tests prevent.
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const caseById = (id: string): EvalCase => {
  const c = SYNTHETIC_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

const corrupt =
  (f: (run: SubjectRun) => void): Subject =>
  async (c) => {
    const run = await productionSubject(c);
    const copy = structuredClone(run);
    f(copy);
    return copy;
  };
const body = (run: SubjectRun) => run.body as Obj;

function failed(r: CaseResult): InvariantId[] {
  return r.checks.filter((c) => c.status === "fail").map((c) => c.invariant);
}

async function expectDetected(id: string, fault: (run: SubjectRun) => void, invariants: InvariantId[]) {
  const r = await evaluateCase(caseById(id), corrupt(fault));
  expect(r.status, `${id} must fail`).toBe("fail");
  for (const inv of invariants) expect(failed(r), `${id} must flag ${inv}`).toContain(inv);
}

describe("positive controls", () => {
  it.each(["EV-001", "EV-003", "EV-014", "EV-035", "EV-045", "EV-049"])("%s passes with the unmodified production subject", async (id) => {
    const r = await evaluateCase(caseById(id), productionSubject);
    expect(r.status).toBe("pass");
  });
});

describe("fault injection: the oracle detects each broken invariant", () => {
  it("confirmationRequired turned false", () =>
    expectDetected("EV-003", (r) => void (body(r).items[0].allergens[0].confirmationRequired = false), ["INV-CONFIRMATION"]));

  it("absence_claim converted to unconfirmed", () =>
    expectDetected(
      "EV-003",
      (r) => void (body(r).items[0].allergens[0] = { code: "peanut", category: "unconfirmed", reason: "not_mentioned", confirmationRequired: true }),
      ["INV-THREE-CATEGORIES", "INV-MENTION-KIND", "PIPELINE-EXPECTATION"],
    ));

  it("absence_claim re-labelled as a different mention kind", () =>
    expectDetected("EV-003", (r) => void (body(r).items[0].allergens[0].mention.kind = "possible_presence"), ["INV-MENTION-KIND"]));

  it("a verdict field added to an assessment", () =>
    expectDetected("EV-003", (r) => void (body(r).items[0].allergens[0].safe = true), ["INV-NO-VERDICT"]));

  it("a verdict field added at top level", () => expectDetected("EV-001", (r) => void (body(r).allergenFree = ["milk"]), ["INV-NO-VERDICT"]));

  it("a fourth category ('absent') appears", () =>
    expectDetected(
      "EV-001",
      (r) => void (body(r).items[0].allergens[2] = { code: "milk", category: "absent", confirmationRequired: true }),
      ["INV-THREE-CATEGORIES", "INV-NO-VERDICT"],
    ));

  it("a selected allergen dropped from an item", () =>
    expectDetected("EV-014", (r) => void body(r).items[0].allergens.splice(1, 1), ["INV-COVERAGE"]));

  it("an unselected allergen kept in an item", () =>
    expectDetected(
      "EV-015",
      (r) => void body(r).items[0].allergens.push({ code: "shrimp", category: "menu_mentions", mention: { kind: "contains_claim", excerpt: "Shrimp" }, confirmationRequired: true }),
      ["INV-COVERAGE"],
    ));

  it("fill-in uses not_mentioned instead of not_assessed", () =>
    expectDetected("EV-014", (r) => void (body(r).items[0].allergens[1].reason = "not_mentioned"), ["INV-NO-ABSENCE-INFERENCE"]));

  it("a missing allergen filled in as ai_inferred (guessing)", () =>
    expectDetected(
      "EV-014",
      (r) => void (body(r).items[0].allergens[1] = { code: "sesame", category: "ai_inferred", rationale: null, confirmationRequired: true }),
      ["INV-NO-ABSENCE-INFERENCE"],
    ));

  it("readBy no longer 'ai'", () => expectDetected("EV-001", (r) => void (body(r).items[0].readText.readBy = "staff"), ["INV-PROVENANCE"]));

  it("translation marked verified", () => expectDetected("EV-001", (r) => void (body(r).items[0].aiTranslation.verified = true), ["INV-PROVENANCE"]));

  it("dataOrigin changed", () => expectDetected("EV-001", (r) => void (body(r).dataOrigin = "mock_fixture"), ["INV-PROVENANCE"]));

  it("readText 'corrected' by post-processing (would hide a misreading)", () =>
    expectDetected("EV-018", (r) => void (body(r).items[0].readText.text = "Shrimp Cocktail"), ["INV-PROVENANCE", "ACCURACY-DETECTION"]));

  it("excerpt no longer contained in readText", () =>
    expectDetected("EV-001", (r) => void (body(r).items[0].allergens[0].mention.excerpt = "prawns"), ["INV-EXCERPT-CONSISTENCY"]));

  it("a menu-wide possible_presence notice dropped", () =>
    expectDetected("EV-049", (r) => void (body(r).menuNotices[0].mentions = []), ["INV-MENTION-KIND", "PIPELINE-EXPECTATION"]));

  it("an output that must be rejected is accepted (fail-open)", async () => {
    const accepted = await productionSubject(caseById("EV-003"));
    await expectDetected(
      "EV-035",
      (r) => {
        r.httpStatus = 200;
        r.body = accepted.body;
      },
      ["INV-FAIL-CLOSED", "PIPELINE-EXPECTATION"],
    );
  });

  it("an error response that still carries items (partial result)", () =>
    expectDetected("EV-021", (r) => void (body(r).items = []), ["INV-FAIL-CLOSED"]));

  it("an unsupported allergen request analysed anyway", async () => {
    const accepted = await productionSubject(caseById("EV-003"));
    await expectDetected(
      "EV-045",
      (r) => {
        r.httpStatus = 200;
        r.body = accepted.body;
        r.modelCalls = 1;
      },
      ["INV-UNSUPPORTED", "INV-MODEL-CALLS"],
    );
  });

  it("menu text written to the logs", () =>
    expectDetected("EV-001", (r) => void r.logs.push({ event: "analyze_menu", debug: "Shrimp Fried Rice - contains shrimp and egg" }), ["INV-NO-BODY-IN-LOGS"]));

  it("an invalid output retried (extra model call)", () => expectDetected("EV-027", (r) => void (r.modelCalls = 2), ["INV-MODEL-CALLS"]));

  it("a network call attempted", () => expectDetected("EV-001", (r) => void (r.networkCalls = 1), ["INV-MODEL-CALLS"]));

  it("an injected verdict passes through", () =>
    expectDetected("EV-041", (r) => void (body(r).items[0].allergens[0].edible = true), ["INV-INJECTION", "INV-NO-VERDICT"]));

  it("a rationale asserting safety", () =>
    expectDetected("EV-006", (r) => void (body(r).items[0].allergens[1].rationale = "Fries are safe to eat."), ["INV-FREE-TEXT-VERDICT"]));
});

describe("regression detection", () => {
  it("flags a worse status, a new failed check, a missing case and a new case", async () => {
    const good = await evaluateCase(caseById("EV-003"), productionSubject);
    const bad = await evaluateCase(caseById("EV-003"), corrupt((r) => void (body(r).items[0].allergens[0].confirmationRequired = false)));
    const other = await evaluateCase(caseById("EV-001"), productionSubject);
    const baseline = toBaseline([good, other]);
    const reg = compareToBaseline([bad], baseline);
    const kinds = reg.regressions.map((g) => `${g.id}:${g.kind}`);
    expect(kinds).toContain("EV-003:worse_status");
    expect(kinds).toContain("EV-003:new_failed_check");
    expect(kinds).toContain("EV-001:missing_case");
    const reg2 = compareToBaseline([good, other], toBaseline([good]));
    expect(reg2.regressions.map((g) => `${g.id}:${g.kind}`)).toEqual(["EV-001:new_case"]);
    expect(compareToBaseline([good, other], baseline).regressions).toEqual([]);
  });
});
