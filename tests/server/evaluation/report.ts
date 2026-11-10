import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EVAL_CONFIG, EVAL_ENV } from "./engine";
import { DECLARED_UNVERIFIED, KNOWN_FAILURES, type DeclaredUnverified, type KnownFailure } from "./knownFailures";
import { COVERAGE_TAGS, INVARIANTS, type CaseResult, type EvalCase, type InvariantId } from "./types";

/*
 * Evaluation report (TEST ONLY). Contains ids, statuses, fixed-vocabulary
 * reasons and paths — never menu text, model output text, images or personal data.
 */

export const EVALUATOR_VERSION = "1.2.0";
export const REPORT_SCHEMA_VERSION = 2;

/** Per-case snapshot used for regression detection (committed as baseline.json). */
export type BaselineEntry = { status: CaseResult["status"]; failed: InvariantId[]; unverified: InvariantId[] };
export type Baseline = { schemaVersion: 1; evaluatorVersion: string; cases: Record<string, BaselineEntry> };

export type Regression = { id: string; kind: "worse_status" | "new_failed_check" | "new_unverified_check" | "missing_case" | "new_case"; detail: string };

/**
 * SAFETY GATE (independent of baseline.json, PR #18 audit MAJOR-2).
 * ok === true only if every FAIL check is an exact allowed (caseId, invariant)
 * pair, every allowance still matches a FAIL, and the unverified cases are
 * exactly the declared ones. Updating the baseline cannot change this result.
 */
export type GateResult = {
  ok: boolean;
  knownFailures: { caseId: string; invariant: InvariantId; severity: "BLOCKER"; issue: string }[];
  unapprovedFailures: { caseId: string; invariant: InvariantId }[];
  staleAllowances: { caseId: string; invariant: InvariantId }[];
  duplicateAllowances: { caseId: string; invariant: InvariantId }[];
  undeclaredUnverified: string[];
  /** Declared unverified cases that are no longer unverified (e.g. turned into PASS). */
  declaredNotUnverified: string[];
};

export function gateResults(
  results: readonly CaseResult[],
  allow: { knownFailures?: readonly KnownFailure[]; declaredUnverified?: readonly DeclaredUnverified[] | null } = {},
): GateResult {
  const known = allow.knownFailures ?? KNOWN_FAILURES;
  const declared = allow.declaredUnverified === undefined ? DECLARED_UNVERIFIED : allow.declaredUnverified;
  const key = (c: string, i: string) => `${c}|${i}`;
  const allowed = new Map<string, KnownFailure>();
  const duplicateAllowances: GateResult["duplicateAllowances"] = [];
  for (const k of known) {
    if (allowed.has(key(k.caseId, k.invariant))) duplicateAllowances.push({ caseId: k.caseId, invariant: k.invariant });
    allowed.set(key(k.caseId, k.invariant), k);
  }
  const failing = new Set<string>();
  const knownFailures: GateResult["knownFailures"] = [];
  const unapprovedFailures: GateResult["unapprovedFailures"] = [];
  for (const r of results) {
    for (const c of r.checks) {
      if (c.status !== "fail") continue;
      failing.add(key(r.id, c.invariant));
      const a = allowed.get(key(r.id, c.invariant));
      if (a) knownFailures.push({ caseId: r.id, invariant: c.invariant, severity: a.severity, issue: a.issue });
      else unapprovedFailures.push({ caseId: r.id, invariant: c.invariant });
    }
  }
  const staleAllowances = known.filter((k) => !failing.has(key(k.caseId, k.invariant))).map((k) => ({ caseId: k.caseId, invariant: k.invariant }));
  let undeclaredUnverified: string[] = [];
  let declaredNotUnverified: string[] = [];
  if (declared !== null) {
    const declaredIds = new Set(declared.map((d) => d.caseId));
    undeclaredUnverified = results.filter((r) => r.status === "unverified" && !declaredIds.has(r.id)).map((r) => r.id);
    declaredNotUnverified = declared.filter((d) => results.find((r) => r.id === d.caseId)?.status !== "unverified").map((d) => d.caseId);
  }
  const ok =
    unapprovedFailures.length === 0 &&
    staleAllowances.length === 0 &&
    duplicateAllowances.length === 0 &&
    undeclaredUnverified.length === 0 &&
    declaredNotUnverified.length === 0;
  return { ok, knownFailures, unapprovedFailures, staleAllowances, duplicateAllowances, undeclaredUnverified, declaredNotUnverified };
}

export type EvalReport = {
  schemaVersion: number;
  generatedAt: string;
  target: { commitSha: string; workingTreeDirty: boolean | "unknown" };
  settings: {
    mode: "offline_synthetic" | "recorded_outputs";
    evaluatorVersion: string;
    subject: string;
    env: Record<string, string>;
    fakeModelName: string;
    caseSetSha256: string;
    realGeminiCalled: false;
    networkCallsAttempted: number;
    notes: string[];
  };
  summary: {
    total: number;
    pass: number;
    fail: number;
    unverified: number;
    byInvariant: Record<InvariantId, { description: string; pass: number; fail: number; unverified: number; notApplicable: number }>;
    coverage: Record<string, number>;
    accuracy: { casesWithReference: number; casesWithFindings: number; findings: number };
  };
  /** Safety gate: known (allowed) FAILs vs unapproved FAILs. Independent of the baseline. */
  gate: GateResult;
  regression: { baselineFound: boolean; regressions: Regression[]; improvements: string[] };
  cases: CaseResult[];
};

export function caseSetHash(cases: readonly EvalCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}

/** Commit under evaluation. Read-only git commands; "unknown" outside a git checkout. */
export function gitTarget(): EvalReport["target"] {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { commitSha: sha, workingTreeDirty: dirty };
  } catch {
    return { commitSha: "unknown", workingTreeDirty: "unknown" };
  }
}

export function toBaseline(results: readonly CaseResult[]): Baseline {
  const cases: Record<string, BaselineEntry> = {};
  for (const r of results) {
    cases[r.id] = {
      status: r.status,
      failed: r.checks.filter((c) => c.status === "fail").map((c) => c.invariant),
      unverified: r.checks.filter((c) => c.status === "unverified").map((c) => c.invariant),
    };
  }
  return { schemaVersion: 1, evaluatorVersion: EVALUATOR_VERSION, cases };
}

const RANK: Record<CaseResult["status"], number> = { pass: 0, unverified: 1, fail: 2 };

export function compareToBaseline(results: readonly CaseResult[], baseline: Baseline | undefined): EvalReport["regression"] {
  if (!baseline) return { baselineFound: false, regressions: [], improvements: [] };
  const current = toBaseline(results).cases;
  const regressions: Regression[] = [];
  const improvements: string[] = [];
  for (const [id, before] of Object.entries(baseline.cases)) {
    const now = current[id];
    if (!now) {
      regressions.push({ id, kind: "missing_case", detail: "case present in baseline is missing" });
      continue;
    }
    if (RANK[now.status] > RANK[before.status]) regressions.push({ id, kind: "worse_status", detail: `${before.status} -> ${now.status}` });
    else if (RANK[now.status] < RANK[before.status]) improvements.push(`${id}: ${before.status} -> ${now.status}`);
    for (const inv of now.failed) if (!before.failed.includes(inv)) regressions.push({ id, kind: "new_failed_check", detail: inv });
    for (const inv of now.unverified) {
      if (!before.unverified.includes(inv) && !before.failed.includes(inv)) regressions.push({ id, kind: "new_unverified_check", detail: inv });
    }
  }
  for (const id of Object.keys(current)) {
    if (!baseline.cases[id]) regressions.push({ id, kind: "new_case", detail: "case not in baseline (update baseline deliberately)" });
  }
  return { baselineFound: true, regressions, improvements };
}

export function buildReport(
  results: readonly CaseResult[],
  cases: readonly EvalCase[],
  opts: { baseline?: Baseline; networkCalls: number; mode?: EvalReport["settings"]["mode"]; now?: Date; target?: EvalReport["target"]; gate?: GateResult },
): EvalReport {
  const byInvariant = Object.fromEntries(
    (Object.keys(INVARIANTS) as InvariantId[]).map((id) => [id, { description: INVARIANTS[id], pass: 0, fail: 0, unverified: 0, notApplicable: 0 }]),
  ) as EvalReport["summary"]["byInvariant"];
  for (const r of results) {
    for (const c of r.checks) {
      const e = byInvariant[c.invariant];
      if (c.status === "pass") e.pass++;
      else if (c.status === "fail") e.fail++;
      else if (c.status === "unverified") e.unverified++;
      else e.notApplicable++;
    }
  }
  const coverage = Object.fromEntries(COVERAGE_TAGS.map((t) => [t, results.filter((r) => r.coverage.includes(t)).length]));
  const withRef = cases.filter((c) => c.reference).map((c) => c.id);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    target: opts.target ?? gitTarget(),
    settings: {
      mode: opts.mode ?? "offline_synthetic",
      evaluatorVersion: EVALUATOR_VERSION,
      subject: "src/server/analyzeMenu.ts handleAnalyzeMenu (production path) with a fake MenuModel test seam",
      env: { NODE_ENV: String(EVAL_ENV.NODE_ENV), GEMINI_ENABLED: String(EVAL_ENV.GEMINI_ENABLED), MOCK_GEMINI: "unset" },
      fakeModelName: EVAL_CONFIG.model,
      caseSetSha256: caseSetHash(cases),
      realGeminiCalled: false,
      networkCallsAttempted: opts.networkCalls,
      notes: notesFor(opts.mode ?? "offline_synthetic"),
    },
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      unverified: results.filter((r) => r.status === "unverified").length,
      byInvariant,
      coverage,
      accuracy: {
        casesWithReference: withRef.length,
        casesWithFindings: results.filter((r) => r.accuracyFindings.length > 0).length,
        findings: results.reduce((n, r) => n + r.accuracyFindings.length, 0),
      },
    },
    gate:
      opts.gate ??
      // Recorded real-model outputs have no allowances and no declared unverified set.
      ((opts.mode ?? "offline_synthetic") === "recorded_outputs" ? gateResults(results, { knownFailures: [], declaredUnverified: null }) : gateResults(results)),
    regression: compareToBaseline(results, opts.baseline),
    cases: [...results],
  };
}

function notesFor(mode: EvalReport["settings"]["mode"]): string[] {
  const common = [
    "本評価の実行中に実Gemini・Vertex AI・GCPを一切呼び出していない（偽モデルがテキストを返す。fetchは評価中ブロック）。",
    "料金・利用回数の実測値は記録しない。本番の利用カウンターは使用しない（インメモリのテスト用ガード）。",
  ];
  if (mode === "recorded_outputs") {
    return [
      ...common,
      "モデル出力は事前に記録されたもの（承認済み合成画像に対する記録、または形式サンプル）を再生している。",
      "参照値との差（accuracyFindings）は記録出力の誤りを示す。件数が少ないため統計的な精度ではない。",
    ];
  }
  return [
    ...common,
    "これは後処理・安全不変条件のオフライン評価であり、実モデルの精度評価ではない。",
    "参照値との差（accuracyFindings）は合成出力に意図的に注入した欠陥の検出確認であり、実モデルの誤り率を示さない。",
  ];
}

const STATUS_JA: Record<string, string> = { pass: "PASS", fail: "FAIL", unverified: "未検証", not_applicable: "対象外" };

export function renderMarkdown(r: EvalReport): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push("# AllergyBridge メニュー解析 オフライン評価レポート", "");
  lines.push(
    r.settings.mode === "recorded_outputs"
      ? "> **実Geminiは呼び出していません。** 事前に記録したモデル出力を偽モデル経由で本番の後処理経路に再生した結果です。"
      : "> **実Geminiは呼び出していません。** 合成テキストを偽モデル経由で本番の後処理経路に通した結果です。実モデルの精度は**未検証**です。",
    "",
  );
  lines.push("## 対象と設定", "");
  lines.push(`- 評価対象コミット: \`${r.target.commitSha}\`（作業ツリー変更あり: ${String(r.target.workingTreeDirty)}）`);
  lines.push(`- 生成日時: ${r.generatedAt}`);
  lines.push(`- モード: ${r.settings.mode} / 評価器 v${r.settings.evaluatorVersion} / ケース集合 sha256: \`${r.settings.caseSetSha256.slice(0, 16)}…\``);
  lines.push(`- 対象: ${r.settings.subject}`);
  lines.push(`- 環境: ${Object.entries(r.settings.env).map(([k, v]) => `${k}=${v}`).join(", ")} / 偽モデル名: ${r.settings.fakeModelName}`);
  lines.push(`- 実Gemini呼び出し: なし / ネットワーク試行: ${r.settings.networkCallsAttempted} 回`);
  for (const n of r.settings.notes) lines.push(`- ${n}`);
  lines.push("", "## 集計", "");
  lines.push(`| 総ケース | PASS | FAIL | 未検証 |`, `|---:|---:|---:|---:|`, `| ${s.total} | ${s.pass} | ${s.fail} | ${s.unverified} |`, "");
  const g = r.gate;
  lines.push("## 安全ゲート（baseline とは独立）", "");
  lines.push(`- 判定: ${g.ok ? "OK（未承認のFAILなし）" : "**NG**"}`);
  lines.push(`- 既知FAIL（明示的許容・BLOCKER）: ${g.knownFailures.length} 件`);
  for (const k of g.knownFailures) lines.push(`  - ${k.caseId} / ${k.invariant}（${k.severity}。修正済みではない。関連: ${k.issue}）`);
  lines.push(`- **未承認の新規FAIL: ${g.unapprovedFailures.length} 件**`);
  for (const u of g.unapprovedFailures) lines.push(`  - ${u.caseId} / ${u.invariant}`);
  if (g.staleAllowances.length) lines.push(`- 陳腐化した許容（もうFAILしていない）: ${g.staleAllowances.map((x) => `${x.caseId}/${x.invariant}`).join(", ")}`);
  if (g.duplicateAllowances.length) lines.push(`- 重複した許容: ${g.duplicateAllowances.map((x) => `${x.caseId}/${x.invariant}`).join(", ")}`);
  if (g.undeclaredUnverified.length) lines.push(`- 宣言されていない未検証: ${g.undeclaredUnverified.join(", ")}`);
  if (g.declaredNotUnverified.length) lines.push(`- 宣言済み未検証のうち未検証でなくなったもの: ${g.declaredNotUnverified.join(", ")}`);
  lines.push("", "## 安全不変条件ごとの結果", "");
  lines.push("| ID | 内容 | PASS | FAIL | 未検証 | 対象外 |", "|---|---|---:|---:|---:|---:|");
  for (const [id, e] of Object.entries(s.byInvariant)) lines.push(`| ${id} | ${e.description} | ${e.pass} | ${e.fail} | ${e.unverified} | ${e.notApplicable} |`);
  lines.push("", "## 網羅領域（ケース数）", "");
  lines.push("| 領域 | ケース数 |", "|---|---:|");
  for (const [t, n] of Object.entries(s.coverage)) lines.push(`| ${t} | ${n} |`);
  lines.push("", "## 回帰", "");
  if (!r.regression.baselineFound) lines.push("- ベースラインなし（回帰判定は未実施）");
  else if (r.regression.regressions.length === 0) lines.push("- 回帰なし（baseline.json と一致）");
  else for (const g of r.regression.regressions) lines.push(`- **${g.id}** ${g.kind}: ${g.detail}`);
  for (const i of r.regression.improvements) lines.push(`- 改善: ${i}`);
  lines.push("", "## 参照値との差（精度軸・合成の注入欠陥）", "");
  lines.push(`- 参照値ありケース: ${s.accuracy.casesWithReference} / 差が出たケース: ${s.accuracy.casesWithFindings} / 差の件数: ${s.accuracy.findings}`);
  lines.push("", "## ケース別", "");
  lines.push("| ID | 結果 | 観測 | 内容 |", "|---|---|---|---|");
  for (const c of r.cases) {
    const obs = c.observed.outcome === "accepted" ? "受理" : `拒否 ${c.observed.errorCode ?? ""}/${c.observed.failure ?? "-"}`;
    const allowedHere = r.gate.knownFailures.some((k) => k.caseId === c.id);
    const unapproved = r.gate.unapprovedFailures.some((u) => u.caseId === c.id);
    const label = c.status === "fail" ? (unapproved ? "FAIL（未承認）" : allowedHere ? "FAIL（既知・BLOCKER）" : "FAIL") : STATUS_JA[c.status];
    lines.push(`| ${c.id} | ${label} | ${obs}（呼出${c.observed.modelCalls}） | ${c.title} |`);
  }
  const problems = r.cases.filter((c) => c.status !== "pass");
  if (problems.length > 0) {
    lines.push("", "## FAIL・未検証の理由", "");
    for (const c of problems) {
      lines.push(`### ${c.id}（${STATUS_JA[c.status]}）`, "");
      for (const ch of c.checks.filter((x) => x.status === "fail" || x.status === "unverified")) {
        lines.push(`- ${STATUS_JA[ch.status]} ${ch.invariant}: ${ch.detail}`);
      }
      for (const f of c.accuracyFindings) lines.push(`- 参照値との差: ${f}`);
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}
