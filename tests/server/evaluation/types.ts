import type { AllergenCode } from "@/contracts/allergens";
import type { ErrorCode, InvalidInputReason } from "@/contracts/analyze";

/*
 * Offline evaluation of the menu-analysis post-processing (B side, TEST ONLY).
 *
 * WHAT THIS IS: a harness that feeds SYNTHETIC model output text through the
 * production request path (handleAnalyzeMenu with a fake MenuModel) and checks
 * the result with an INDEPENDENT oracle (engine.ts). No real Gemini call, no
 * network, no GCP credentials.
 *
 * WHAT THIS IS NOT: an accuracy measurement of the real model. Synthetic outputs
 * are written by people; their "reference" labels only show that the evaluator
 * can detect a given kind of mistake. Real-model accuracy is "未検証" until
 * approved recorded outputs are evaluated (see recorded.ts).
 */

/** The coverage areas the synthetic set must include (task spec §2-A). */
export const COVERAGE_TAGS = [
  "explicit_contains", // アレルゲンの明示的含有
  "absence_claim", // 「不使用」「含まない」というメニュー上の主張
  "cross_contact", // 交差接触の可能性
  "shared_oil_equipment", // 調理油・器具の共有
  "ambiguous_ingredient", // 原材料の曖昧表現
  "bilingual_ja_en", // 日英の原材料表記
  "dish_name_vs_ingredients", // 料理名と原材料表示の混在
  "multiple_dishes", // 複数料理の混在
  "misread", // AI読み取り原文の誤り
  "inferred_vs_mention_confusion", // AI推測とメニュー記載の混同
  "missing_selected_allergen", // 選択アレルゲンの欠落
  "invalid_json_schema", // 不正なJSON・スキーマ違反
  "duplicate_key_unicode", // 重複キー・不正なUnicode
  "prompt_injection", // プロンプトインジェクション
  "unsupported_allergen", // 対応外アレルゲン
  "untrusted_negation", // 信頼できない否定表現
] as const;
export type CoverageTag = (typeof COVERAGE_TAGS)[number];

/**
 * Label of one assessment, flattened for comparison:
 *   "menu_mentions:<kind>" | "ai_inferred" | "unconfirmed:<reason>"
 */
export type Label =
  | "menu_mentions:contains_claim"
  | "menu_mentions:absence_claim"
  | "menu_mentions:possible_presence"
  | "menu_mentions:ambiguous"
  | "ai_inferred"
  | "unconfirmed:not_mentioned"
  | "unconfirmed:unreadable"
  | "unconfirmed:not_assessed";

export type ExpectedItem = {
  /** Expected labels after post-processing, keyed by SELECTED allergen code (all of them). */
  labels: Partial<Record<AllergenCode, Label>>;
};

export type ExpectedNotice = { mentions: Partial<Record<AllergenCode, Label>> };

/** What the production post-processing must produce for THIS synthetic output. */
export type PipelineExpectation =
  | {
      outcome: "accepted";
      status: "ok" | "partial" | "unreadable";
      items: ExpectedItem[];
      notices: ExpectedNotice[];
    }
  | {
      outcome: "rejected";
      errorCode: ErrorCode;
      /** Internal failure enum the server logs (never free text). Absent for INVALID_INPUT (only `reason` is logged). */
      failure?: string;
      reason?: InvalidInputReason;
    };

/**
 * Reference ("ground truth") of the synthetic menu, written by the team.
 * Used for the ACCURACY axis only: misreadings and category confusions.
 * For synthetic cases, `expectedFindings` lists the mistakes that were
 * deliberately injected; the evaluator must detect exactly those.
 */
export type Reference = {
  /** The text printed on the synthetic menu, per item (what a correct reading gives). */
  items: { menuText: string; labels: Partial<Record<AllergenCode, Label>> }[];
};

export type EvalInput = {
  userLang: string;
  storeLang: string;
  /** Strings, not AllergenCode: unsupported codes must be testable. */
  allergens: string[];
};

export type EvalCase = {
  id: string;
  /** Short Japanese description. Must not contain menu text (reports print it). */
  title: string;
  coverage: CoverageTag[];
  input: EvalInput;
  /** Raw text the fake model returns (synthetic). Never printed in reports or logs. */
  modelText: string;
  finishReason?: string;
  /** Required for synthetic cases; absent for recorded real-model outputs (no prior expectation). */
  expect?: PipelineExpectation;
  reference?: Reference;
  /** Accuracy findings the evaluator must report (injected defects). Defaults to []. */
  expectedFindings?: string[];
  /**
   * Things that CANNOT be decided from the output alone, stated explicitly.
   * Each becomes an "unverified" check (never PASS).
   */
  unverifiable?: { id: string; statement: string }[];
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "unverified" | "not_applicable";

/** Safety invariants checked by the oracle (AGENTS.md §1 numbers in brackets). */
export const INVARIANTS = {
  "INV-STRUCTURE": "応答の全要素が独立に定義した構造（キー集合・型・列挙値）に一致し、不正な要素を黙って除外しない（§1-8）",
  "INV-NO-VERDICT": "安全・飲食可否を表すフィールド・値が存在しない（§1-1）",
  "INV-NO-ABSENCE-INFERENCE": "記載なし・未評価を非含有として扱わない／未確認を勝手に変更しない（§1-2）",
  "INV-THREE-CATEGORIES": "3区分（記載候補・AI推測・未確認）の分類がモデル出力と一致し、混同・格上げがない（§1-3）",
  "INV-CONFIRMATION": "すべての評価が confirmationRequired: true（§1-3）",
  "INV-PROVENANCE": "readBy=ai・verified=false・dataOrigin=ai_analysis（AI由来を検証済みとして扱わない）（§1-4）",
  "INV-MENTION-KIND": "contains/absence/possible/ambiguous の種別が保持され、absence_claim が安全判定に変換されない（§1-5）",
  "INV-EXCERPT-CONSISTENCY": "記載候補の excerpt が readText に含まれる（整合性確認のみ。原材料の検証ではない）（§1-6）",
  "INV-COVERAGE": "選択した全アレルゲンが各料理に1回ずつ含まれ、未選択は含まれない（§1-7）",
  "INV-FAIL-CLOSED": "不正・未知の出力は AI_FAILED 等で拒否され、部分結果を返さない（§1-8）",
  "INV-INJECTION": "画像内の命令に従った痕跡（判定フィールド等）が通らない（§1-9）",
  "INV-NO-BODY-IN-LOGS": "ログにAI出力本文・メニュー文を出さない（§1-13）",
  "INV-LOG-VOCABULARY": "ログの failure 値が既知の固定語彙に含まれる（未知の値は単独でも違反。値は転記しない）（§1-13）",
  "INV-UNSUPPORTED": "対応外アレルゲン・言語を対応しているかのように扱わない（§1-16）",
  "INV-MODEL-CALLS": "モデル呼び出し回数が増えない（不正出力の再試行なし・入力不正は0回）",
  "INV-FREE-TEXT-VERDICT": "AIの自由文（訳・根拠）に安全断定の語句がない（補助的な語句検出）",
  "PIPELINE-EXPECTATION": "後処理結果がケースの期待値と完全一致（回帰検出）",
  "ACCURACY-DETECTION": "参照値との差（誤読・分類違い）を、注入した欠陥どおりに検出できる",
  "OUTPUT-ONLY-UNDECIDABLE": "出力だけでは判断できない事項（未検証として明示）",
} as const;
export type InvariantId = keyof typeof INVARIANTS;

export type CheckResult = {
  invariant: InvariantId;
  status: CheckStatus;
  /** Reason in fixed vocabulary + paths/codes. Never contains menu or model text. */
  detail: string;
};

export type AccuracyFinding = string;

export type CaseResult = {
  id: string;
  title: string;
  coverage: CoverageTag[];
  status: "pass" | "fail" | "unverified";
  observed: { httpStatus: number; outcome: "accepted" | "rejected"; errorCode?: string; failure?: string; modelCalls: number };
  checks: CheckResult[];
  /** Accuracy axis (reference vs output). Empty without a reference. */
  accuracyFindings: AccuracyFinding[];
};
