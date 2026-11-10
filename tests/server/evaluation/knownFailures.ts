import type { InvariantId } from "./types";

/*
 * EXPLICIT ALLOWANCES for known safety FAILs and declared "unverified" cases
 * (TEST ONLY). Kept SEPARATE from baseline.json on purpose (PR #18 audit MAJOR-2):
 *
 *  - baseline.json only records "what the output looked like" for regression
 *    detection. Updating it can NEVER make a new FAIL acceptable.
 *  - The safety gate (gateResults in report.ts) fails the test run if ANY fail
 *    check is not listed here as an exact (caseId, invariant) pair, if a listed
 *    pair no longer fails (stale allowance), or if the set of "unverified"
 *    cases differs from DECLARED_UNVERIFIED (in either direction).
 *  - Changing this file is a safety decision: it needs review by both
 *    developers. offlineEvaluation.test.ts pins the exact list so an expansion
 *    always shows up in two places of the diff.
 *
 * An allowance is NOT a statement that the behaviour is acceptable or that AI
 * output is safe. It only keeps a known, tracked FAIL visible without hiding
 * new ones.
 */

export type KnownFailure = {
  caseId: string;
  invariant: InvariantId;
  severity: "BLOCKER";
  /** What is blocked until the failure is fixed. */
  blocks: string;
  reason: string;
  /** Related issue / PR. */
  issue: string;
  /** Condition for deleting this entry. */
  removeWhen: string;
};

/*
 * Empty. EV-052 × INV-FREE-TEXT-VERDICT was removed when the production fix
 * (AI rationale is never published: src/server/gemini/modelOutput.ts and the
 * final check in analyzeWithGemini.ts) made EV-052 stop failing. Adding an entry
 * again is a safety decision that needs review by both developers.
 */
export const KNOWN_FAILURES: readonly KnownFailure[] = [];

export type DeclaredUnverified = { caseId: string; reason: string };

/** Cases whose result is "unverified" by design: the output alone cannot decide them. */
export const DECLARED_UNVERIFIED: readonly DeclaredUnverified[] = [
  { caseId: "EV-019", reason: "誤読で消えた含有記載は出力だけでは検出できない" },
  { caseId: "EV-041", reason: "実モデルが画像内の命令に従わないかは合成出力では検証できない" },
  { caseId: "EV-043", reason: "記載の取りこぼしは後処理では検出できない" },
  { caseId: "EV-044", reason: "訳文中の「安全」が原文の訳かAIの断定か出力だけでは判別できない" },
];
