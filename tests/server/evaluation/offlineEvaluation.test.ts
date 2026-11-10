import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYNTHETIC_CASES } from "./cases";
import { evaluateCase, freeTextsOf, productionSubject, type SubjectRun } from "./engine";
import { DECLARED_UNVERIFIED, KNOWN_FAILURES } from "./knownFailures";
import { buildReport, renderMarkdown, toBaseline, type Baseline, type EvalReport } from "./report";
import { COVERAGE_TAGS, type CaseResult } from "./types";

/*
 * Offline evaluation of the menu-analysis post-processing over the SYNTHETIC
 * case set (no real Gemini, no network). Runs in `npm test`.
 *
 *   Write a report:       EVAL_REPORT=1 npx vitest run tests/server/evaluation
 *                         → test-results/offline-eval/report.{json,md} (git-ignored)
 *   Update the baseline:  EVAL_UPDATE_BASELINE=1 npx vitest run tests/server/evaluation
 *                         (only after reviewing why a result changed; refused while
 *                         the safety gate is NG)
 *
 * TWO SEPARATE MECHANISMS (PR #18 audit MAJOR-2):
 *   - safety gate (knownFailures.ts): every FAIL must be an explicitly allowed
 *     (caseId, invariant) pair; allowances must still match; unverified cases
 *     must be exactly the declared ones. Independent of baseline.json.
 *   - baseline.json: regression snapshot of normal output only. Updating it can
 *     never make a new FAIL pass the gate.
 * A green test run means "no unapproved FAIL and no regression" — NOT that all
 * evaluation cases PASS (4 cases are "unverified" by design; see DECLARED_UNVERIFIED).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, "baseline.json");
const REPORT_DIR = resolve(HERE, "../../../test-results/offline-eval");

let results: CaseResult[] = [];
let networkCalls = 0;
let report: EvalReport;
const baseline: Baseline | undefined = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline) : undefined;

beforeAll(async () => {
  const counted = async (c: (typeof SYNTHETIC_CASES)[number]): Promise<SubjectRun> => {
    const run = await productionSubject(c);
    networkCalls += run.networkCalls;
    return run;
  };
  results = [];
  for (const c of SYNTHETIC_CASES) results.push(await evaluateCase(c, counted));
  report = buildReport(results, SYNTHETIC_CASES, { baseline, networkCalls });
  // A baseline is never written while the gate reports an unapproved FAIL (it would not help anyway).
  if (process.env.EVAL_UPDATE_BASELINE === "1" && report.gate.ok) {
    writeFileSync(BASELINE_PATH, JSON.stringify(toBaseline(results), null, 2) + "\n");
  }
  if (process.env.EVAL_REPORT === "1") {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(REPORT_DIR, "report.md"), renderMarkdown(report));
  }
});

const byId = (id: string) => results.find((r) => r.id === id)!;
const check = (id: string, inv: string) => byId(id).checks.find((c) => c.invariant === inv)!;

describe("synthetic case set", () => {
  it("has unique ids, a pipeline expectation for every case, and covers every required area", () => {
    const ids = SYNTHETIC_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SYNTHETIC_CASES.length).toBeGreaterThanOrEqual(40);
    for (const c of SYNTHETIC_CASES) {
      expect(c.expect, c.id).toBeDefined();
      expect(c.coverage.length, c.id).toBeGreaterThan(0);
      for (const t of c.coverage) expect(COVERAGE_TAGS).toContain(t);
      // titles are printed in reports: they must not carry menu/model text
      for (const t of freeTextsOf(c.modelText, { excerpts: false })) expect(c.title.includes(t), c.id).toBe(false);
      // a reference only makes sense for synthetic menus written by the team
      if (c.expectedFindings) expect(c.reference, c.id).toBeDefined();
    }
    for (const tag of COVERAGE_TAGS) {
      expect(SYNTHETIC_CASES.filter((c) => c.coverage.includes(tag)).length, tag).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("offline evaluation (production post-processing path, fake model)", () => {
  it("never touches the network and never calls a real model", () => {
    expect(networkCalls).toBe(0);
    expect(report.settings.realGeminiCalled).toBe(false);
    for (const r of results) expect(r.observed.modelCalls, r.id).toBeLessThanOrEqual(1);
  });

  it("matches the hand-written pipeline expectation for every case", () => {
    for (const r of results) expect(check(r.id, "PIPELINE-EXPECTATION"), r.id).toMatchObject({ status: "pass" });
  });

  it("holds the core safety invariants in every case", () => {
    const core = [
      "INV-NO-VERDICT",
      "INV-NO-ABSENCE-INFERENCE",
      "INV-THREE-CATEGORIES",
      "INV-CONFIRMATION",
      "INV-PROVENANCE",
      "INV-MENTION-KIND",
      "INV-EXCERPT-CONSISTENCY",
      "INV-COVERAGE",
      "INV-FAIL-CLOSED",
      "INV-INJECTION",
      "INV-NO-BODY-IN-LOGS",
      "INV-LOG-VOCABULARY",
      "INV-STRUCTURE",
      "INV-UNSUPPORTED",
      "INV-MODEL-CALLS",
    ];
    for (const r of results) {
      for (const c of r.checks.filter((x) => core.includes(x.invariant))) {
        expect(c.status, `${r.id} ${c.invariant}: ${c.detail}`).not.toBe("fail");
      }
    }
  });

  it("detects exactly the defects injected on the accuracy axis", () => {
    for (const r of results) expect(check(r.id, "ACCURACY-DETECTION").status, r.id).not.toBe("fail");
    expect(byId("EV-019").accuracyFindings).toContain("items[0].crab: menu_mentions:contains_claim -> unconfirmed:not_mentioned");
    expect(byId("EV-020").accuracyFindings).toEqual(["items[0].wheat: ai_inferred -> menu_mentions:contains_claim"]);
  });

  it("reports known limitations honestly instead of passing them", () => {
    // EV-052 (fixed in production): the model's rationale asserted safety; the
    // server never publishes an AI rationale, so the case PASSES. Its free-text
    // check is "not_applicable" — there is no published rationale (and no
    // translation) left to inspect. That is NOT a statement that AI text is safe.
    expect(byId("EV-052").status).toBe("pass");
    expect(check("EV-052", "INV-FREE-TEXT-VERDICT").status).toBe("not_applicable");
    expect(byId("EV-052").checks.filter((c) => c.status === "fail")).toEqual([]);
    // A translation containing "安全" may be a faithful translation of printed (injected) text.
    expect(check("EV-044", "INV-FREE-TEXT-VERDICT").status).toBe("unverified");
    // Model behaviour under injection cannot be checked with synthetic outputs.
    expect(byId("EV-041").status).toBe("unverified");
  });

  it("EV-052 production output: the rationale is null and nothing else about the assessment changed", async () => {
    const c = SYNTHETIC_CASES.find((x) => x.id === "EV-052")!;
    expect(c.modelText).toContain("so it is safe for peanut allergies."); // the case input itself is unchanged
    const run = await productionSubject(c);
    const body = run.body as { dataOrigin: string; items: { allergens: unknown[] }[] };
    expect(body.dataOrigin).toBe("ai_analysis");
    expect(body.items[0]!.allergens).toEqual([{ code: "peanut", category: "ai_inferred", rationale: null, confirmationRequired: true }]);
    expect(JSON.stringify(run.body)).not.toContain("safe for peanut");
    expect(JSON.stringify(run.logs)).not.toContain("safe for peanut");
  });

  it("SAFETY GATE: no unapproved FAIL, no stale allowance, unverified exactly as declared (independent of baseline)", () => {
    expect(report.gate.unapprovedFailures, "unapproved FAIL (fix it; do not extend the allowance without review)").toEqual([]);
    expect(report.gate.staleAllowances, "stale allowance: remove it from knownFailures.ts").toEqual([]);
    expect(report.gate.duplicateAllowances).toEqual([]);
    expect(report.gate.undeclaredUnverified).toEqual([]);
    expect(report.gate.declaredNotUnverified, "a declared unverified case changed status").toEqual([]);
    expect(report.gate.ok).toBe(true);
    expect(report.gate.knownFailures).toEqual([]);
  });

  it("pins the allowance lists (any expansion must change this test too and be reviewed by A and B)", () => {
    expect(KNOWN_FAILURES.map((k) => `${k.caseId}/${k.invariant}/${k.severity}`)).toEqual([]);
    for (const k of KNOWN_FAILURES) {
      expect(SYNTHETIC_CASES.some((c) => c.id === k.caseId)).toBe(true);
      for (const f of [k.reason, k.issue, k.blocks, k.removeWhen]) expect(f.trim().length).toBeGreaterThan(10);
    }
    expect(DECLARED_UNVERIFIED.map((d) => d.caseId)).toEqual(["EV-019", "EV-041", "EV-043", "EV-044"]);
    for (const d of DECLARED_UNVERIFIED) expect(d.reason.trim().length).toBeGreaterThan(5);
  });

  it("has no regression against the committed baseline (and the baseline is up to date)", () => {
    expect(baseline, "baseline.json missing: run with EVAL_UPDATE_BASELINE=1 after review").toBeDefined();
    expect(report.regression.regressions).toEqual([]);
    expect(toBaseline(results)).toEqual(baseline);
  });

  it("produces a report without menu text, model text or images", () => {
    const json = JSON.stringify(report);
    const md = renderMarkdown(report);
    for (const c of SYNTHETIC_CASES) {
      for (const t of freeTextsOf(c.modelText, { excerpts: false })) {
        expect(json.includes(t), c.id).toBe(false);
        expect(md.includes(t), c.id).toBe(false);
      }
    }
    expect(json).not.toMatch(/data:image|base64,/);
    expect(report.summary.total).toBe(SYNTHETIC_CASES.length);
    expect(report.summary.pass + report.summary.fail + report.summary.unverified).toBe(report.summary.total);
    expect(report.target.commitSha).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(md).toContain("実Geminiは呼び出していません");
  });
});
