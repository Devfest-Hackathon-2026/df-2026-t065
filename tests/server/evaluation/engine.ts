import { ALLERGEN_CODES } from "@/contracts/allergens";
import { SUPPORTED_LANGUAGE_PAIRS } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import type { MenuModel } from "@/server/gemini/vertexClient";
import { blob, fakeJpeg, testUsageGuard } from "../helpers";
import type { CaseResult, CheckResult, CheckStatus, EvalCase, InvariantId, Label } from "./types";
import { INVARIANTS } from "./types";

/*
 * Offline evaluation engine (TEST ONLY).
 *
 * SUBJECT = the production request path, unchanged: handleAnalyzeMenu with its
 * documented test seams (fake MenuModel, fixed config, in-memory usage guard).
 * So every case goes through the real form validation, image verification,
 * strict JSON parser, model-output schema, conversion, projection, fill-in and
 * final invariant checks — nothing is re-implemented for the subject.
 *
 * ORACLE = the checks below. They deliberately do NOT call the contract helpers
 * (findIntegrityViolations, normalizeForMatch, ...) or zod schemas, so a bug in
 * those helpers is not hidden by the same bug in the evaluator. The oracle only
 * looks at what the subject returned (HTTP status, JSON body, log events,
 * number of model calls) plus the case's own synthetic model text.
 *
 * Nothing the output cannot show is assumed: such items are reported as
 * "unverified" (未検証), never as PASS.
 */

export const EVAL_ENV: AnalyzeEnv = { NODE_ENV: "production", GEMINI_ENABLED: "true" };

/** Fixed config for the fake model. No project/location is ever contacted. */
export const EVAL_CONFIG: GeminiConfig = {
  project: "offline-eval-no-project",
  location: "offline-eval-no-location",
  model: "offline-fake-model",
  attemptTimeoutMs: 5_000,
  requestDeadlineMs: 20_000,
  maxOutputTokens: 4096,
};

export type SubjectRun = {
  httpStatus: number;
  body: unknown;
  logs: unknown[];
  modelCalls: number;
  networkCalls: number;
};

export type Subject = (c: EvalCase) => Promise<SubjectRun>;

export function requestIdFor(c: EvalCase): string {
  return `eval-${c.id}`;
}

/** The production path with a fake model that returns the case's synthetic text. */
export const productionSubject: Subject = async (c) => {
  let modelCalls = 0;
  const model: MenuModel = {
    async generate() {
      modelCalls++;
      return { text: c.modelText, finishReason: c.finishReason ?? "STOP" };
    },
  };
  const form = new FormData();
  form.append("userLang", c.input.userLang);
  form.append("storeLang", c.input.storeLang);
  for (const a of c.input.allergens) form.append("allergens", a);
  form.append("image", blob(fakeJpeg(), "image/jpeg"), "synthetic.jpg");
  const req = new Request("http://offline-eval.invalid/api/analyze-menu", { method: "POST", body: form });
  const logs: unknown[] = [];
  return withNetworkBlocked(async (networkCalls) => {
    const res = await handleAnalyzeMenu(req, EVAL_ENV, {
      model,
      config: EVAL_CONFIG,
      usage: testUsageGuard(),
      logger: (e) => logs.push(structuredClone(e)),
      sleep: async () => {},
      newRequestId: () => requestIdFor(c),
    });
    const body: unknown = await res.json();
    return { httpStatus: res.status, body, logs, modelCalls, networkCalls: networkCalls() };
  });
};

/**
 * Replaces global fetch for the duration of `fn`: any network attempt is
 * counted and rejected, so the evaluation provably makes no outbound call
 * through fetch (Vertex AI SDK included).
 */
async function withNetworkBlocked<T>(fn: (calls: () => number) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("network disabled during offline evaluation");
  }) as typeof fetch;
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = real;
  }
}


// ---------------------------------------------------------------------------
// Oracle vocabulary (written independently of src/contracts schemas on purpose)
// ---------------------------------------------------------------------------
//
// REPORT SAFETY (MINOR-1): every string that leaves the oracle (check details,
// accuracy findings, observed codes) is built ONLY from:
//   - the fixed vocabulary below (key names, enum values, failure codes),
//   - array indices and counts,
//   - safe*() conversions that map anything unknown to a fixed placeholder.
// Unknown key names, unknown enum values and logger values are never copied.

const CODES = new Set<string>(ALLERGEN_CODES);
const CATEGORIES = new Set(["menu_mentions", "ai_inferred", "unconfirmed"]);
const KINDS = new Set(["contains_claim", "absence_claim", "possible_presence", "ambiguous"]);
const REASONS = new Set(["not_mentioned", "unreadable", "not_assessed"]);
const STATUSES = new Set(["ok", "partial", "unreadable"]);
const DATA_ORIGINS = new Set(["ai_analysis", "mock_fixture"]);
const IMAGE_ISSUES = new Set(["blurry", "cropped", "low_light", "not_a_menu"]);
const READABILITY = new Set(["clear", "partially_readable"]);
const ERROR_CODES = new Set(["INVALID_INPUT", "RATE_LIMITED", "AI_DISABLED", "AI_TIMEOUT", "AI_FAILED"]);
const INPUT_REASONS = new Set([
  "malformed_request",
  "image_missing",
  "image_too_large",
  "unsupported_image_type",
  "unsupported_language_pair",
  "invalid_allergens",
]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Language tag grammar of the public contract (BCP 47 subset), re-implemented
 * by hand without the contract's regex (PR #18 re-audit MINOR-2):
 *   primary subtag: 2–3 lowercase ASCII letters
 *   each further subtag (after a single "-"): 2–8 ASCII letters or digits
 * e.g. "ja", "en", "fil", "en-US", "zh-Hant-TW", "es-419" are valid; "", "EN",
 * "en_US", "en-", "en--US", "-en", "e", "en-x" are not. No stricter rule
 * (no registry lookup) is added.
 */
export function isContractLanguageTag(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const parts = v.split("-");
  const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
  const isAlnum = (c: number) => isLower(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
  const all = (t: string, f: (c: number) => boolean) => [...t].every((ch) => ch.length === 1 && f(ch.charCodeAt(0)));
  const [primary, ...rest] = parts;
  if (primary === undefined || primary.length < 2 || primary.length > 3 || !all(primary, isLower)) return false;
  return rest.every((t) => t.length >= 2 && t.length <= 8 && all(t, isAlnum));
}

/** Internal failure codes the server may log (fixed enum values in src/server). Anything else → "unrecognized_failure". */
export const KNOWN_FAILURE_CODES = new Set([
  "blocked",
  "clock_invalid",
  "credentials_unavailable",
  "daily_limit_reached",
  "deadline_exceeded_before_call",
  "empty_output",
  "endpoint_not_allowed",
  "endpoint_override_blocked",
  "finish_not_stop",
  "invariants",
  "invariants_final",
  "ai_rationale_not_redacted", // EV-052 final check in analyzeWithGemini (fail closed)
  "kill_switch_off",
  "malformed_response",
  "mock_error",
  "model_duplicate_key",
  "model_inconsistent_assessment",
  "model_invalid_json",
  "model_json_too_deep",
  "model_json_too_large",
  "model_schema",
  "network",
  "not_configured",
  "public_schema",
  "public_schema_final",
  "rate_check_late",
  "rate_limited",
  "raw_response_rejected",
  "raw_response_too_large",
  "reservation_missing",
  "reservation_not_yet_valid",
  "timeout",
  "unexpected_part",
  "unknown",
  "upstream_auth",
  "upstream_error",
  "upstream_not_found",
  "upstream_rate_limited",
  "upstream_transient",
  "usage_config_invalid",
  "usage_reservation_late",
  "usage_store_error",
  "usage_store_timeout",
  "usage_store_unavailable",
]);

/** Every key name that may appear in a response; used to build report-safe paths. */
const KNOWN_KEYS = new Set([
  "requestId",
  "status",
  "dataOrigin",
  "imageIssues",
  "items",
  "menuNotices",
  "id",
  "readText",
  "aiTranslation",
  "readability",
  "allergens",
  "text",
  "lang",
  "readBy",
  "verified",
  "code",
  "category",
  "mention",
  "kind",
  "excerpt",
  "rationale",
  "reason",
  "confirmationRequired",
  "mentions",
  "error",
  "retryable",
]);

/** Exact key sets per object type: [required, optional]. */
const SHAPES = {
  response: [["requestId", "status", "dataOrigin", "imageIssues", "items", "menuNotices"], []],
  item: [["id", "readText", "aiTranslation", "readability", "allergens"], []],
  readText: [["text", "lang", "readBy"], []],
  translation: [["text", "lang", "verified"], []],
  menu_mentions: [["code", "category", "mention", "confirmationRequired"], []],
  mention: [["kind", "excerpt"], []],
  ai_inferred: [["code", "category", "rationale", "confirmationRequired"], []],
  unconfirmed: [["code", "category", "reason", "confirmationRequired"], []],
  notice: [["id", "readText", "aiTranslation", "mentions"], []],
  noticeMention: [["code", "kind"], []],
  error: [["requestId", "error"], []],
  errorInner: [["code", "retryable"], ["reason"]],
} as const satisfies Record<string, readonly [readonly string[], readonly string[]]>;
type Shape = keyof typeof SHAPES;

/** Any key that could express a verdict. Matches anywhere in the body. */
const VERDICT_KEY = /safe|edible|absent|allergen_?free|verdict|ok_?to_?eat|suitab|harmless|approved|verified_?ingredient/i;

/**
 * AUXILIARY wording detection for AI free text (translation / rationale).
 * Word lists are never a safety guarantee and string matching never proves a
 * violation (AGENTS.md §1): a hit marks the text for human review.
 */
const VERDICT_WORDING = [
  /\bsafe\b/i,
  /\bsafely\b/i,
  /\bedible\b/i,
  /\b(ok|okay|fine) to eat\b/i,
  /\bno (allergy )?risk\b/i,
  /\bsuitable for\b/i,
  /安全/,
  /食べられ/,
  /食べても(大丈夫|問題)/,
  /問題(あり|ござい)ません/,
  /心配(あり|ござい)ません/,
  /大丈夫です/,
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const safeEnum = (v: unknown, set: ReadonlySet<string>): string => (typeof v === "string" && set.has(v) ? v : "<invalid>");
const safeCode = (v: unknown): string => safeEnum(v, CODES);
const safeKey = (k: string): string => (KNOWN_KEYS.has(k) ? k : "<unknown-key>");

/** Comparison normalization written independently of normalizeForMatch. */
export function oracleNormalize(s: string): string {
  return s.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Label of a PUBLIC assessment; anything outside the vocabulary becomes "invalid". */
function labelOf(a: unknown): Label | "invalid" {
  if (!isObj(a)) return "invalid";
  if (a.category === "menu_mentions") {
    const k = isObj(a.mention) ? a.mention.kind : undefined;
    return typeof k === "string" && KINDS.has(k) ? (`menu_mentions:${k}` as Label) : "invalid";
  }
  if (a.category === "ai_inferred") return "ai_inferred";
  if (a.category === "unconfirmed") return typeof a.reason === "string" && REASONS.has(a.reason) ? (`unconfirmed:${a.reason}` as Label) : "invalid";
  return "invalid";
}

/** Label of an entry of the MODEL output format; anything outside the vocabulary becomes "invalid". */
function modelLabelOf(a: Obj): Label | "invalid" {
  if (a.category === "menu_mentions") {
    return typeof a.mentionKind === "string" && KINDS.has(a.mentionKind) ? (`menu_mentions:${a.mentionKind}` as Label) : "invalid";
  }
  if (a.category === "ai_inferred") return "ai_inferred";
  if (a.category === "unconfirmed") {
    return typeof a.unconfirmedReason === "string" && REASONS.has(a.unconfirmedReason) ? (`unconfirmed:${a.unconfirmedReason}` as Label) : "invalid";
  }
  return "invalid";
}

/** Walks every key; the reported path uses known key names only. */
function walkKeys(v: unknown, path: string, visit: (key: string, parentPath: string) => void): void {
  if (Array.isArray(v)) v.forEach((x, i) => walkKeys(x, `${path}[${i}]`, visit));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      visit(k, path);
      walkKeys(x, `${path}.${safeKey(k)}`, visit);
    }
  }
}

const FREE_TEXT_FIELDS = ["readText", "translation", "rationale", "excerpt"];

/**
 * Free-text strings (≥ 6 chars) of the synthetic model output: menu text,
 * translations, rationales and (optionally) excerpts. Excerpts are short
 * fragments of readText; reports may name such words in case titles.
 */
export function freeTextsOf(modelText: string, opts: { excerpts?: boolean } = {}): string[] {
  const fields = opts.excerpts === false ? FREE_TEXT_FIELDS.filter((f) => f !== "excerpt") : FREE_TEXT_FIELDS;
  const out: string[] = [];
  try {
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (isObj(v)) {
        for (const [k, x] of Object.entries(v)) {
          if (fields.includes(k) && typeof x === "string") out.push(x);
          else collect(x);
        }
      }
    };
    collect(JSON.parse(modelText));
  } catch {
    // Unparseable on purpose: take the quoted strings that follow a free-text key.
    const re = /"(readText|translation|rationale|excerpt)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    for (const m of modelText.matchAll(re)) if (fields.includes(m[1]!)) out.push(m[2]!);
  }
  return out.filter((s) => s.trim().length >= 6);
}

function isSupportedPair(userLang: string, storeLang: string): boolean {
  return SUPPORTED_LANGUAGE_PAIRS.some((p) => p.userLang === userLang && p.storeLang === storeLang);
}

// ---------------------------------------------------------------------------
// Check collector
// ---------------------------------------------------------------------------

class Checks {
  private readonly map = new Map<InvariantId, { status: CheckStatus; details: string[] }>();
  /** Marks the invariant as checked (pass unless a failure is added). */
  applies(id: InvariantId): void {
    if (!this.map.has(id)) this.map.set(id, { status: "pass", details: [] });
  }
  fail(id: InvariantId, detail: string): void {
    this.applies(id);
    const e = this.map.get(id)!;
    e.status = "fail";
    if (e.details.length < 20 && !e.details.includes(detail)) e.details.push(detail);
  }
  unverified(id: InvariantId, detail: string): void {
    this.applies(id);
    const e = this.map.get(id)!;
    if (e.status !== "fail") e.status = "unverified";
    if (e.details.length < 20 && !e.details.includes(detail)) e.details.push(detail);
  }
  result(): CheckResult[] {
    return (Object.keys(INVARIANTS) as InvariantId[]).map((id) => {
      const e = this.map.get(id);
      if (!e) return { invariant: id, status: "not_applicable", detail: "" };
      return { invariant: id, status: e.status, detail: e.details.join("; ") };
    });
  }
}

/**
 * Exact key-set check. Missing keys are named (they come from SHAPES); extra
 * keys are only COUNTED, so arbitrary key names never reach a report.
 * Returns false if the value is not an object at all.
 */
function shape(ck: Checks, v: unknown, kind: Shape, p: string): v is Obj {
  if (!isObj(v)) {
    ck.fail("INV-STRUCTURE", `${p}: expected ${kind} object, got ${typeName(v)}`);
    return false;
  }
  const [required, optional] = SHAPES[kind];
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(v, k)) ck.fail("INV-STRUCTURE", `${p}: missing required key ${k}`);
  const allowed = new Set<string>([...required, ...optional]);
  const extra = Object.keys(v).filter((k) => !allowed.has(k)).length;
  if (extra > 0) {
    ck.fail("INV-STRUCTURE", `${p}: ${extra} unexpected key(s)`);
    ck.fail("INV-NO-VERDICT", `${p}: ${extra} key(s) outside the closed key set`);
  }
  return true;
}

function str(ck: Checks, v: unknown, p: string, opts: { nonEmpty?: boolean; nullable?: boolean; pattern?: RegExp } = {}): boolean {
  if (v === null && opts.nullable) return true;
  if (typeof v !== "string") {
    ck.fail("INV-STRUCTURE", `${p}: expected ${opts.nullable ? "string or null" : "string"}, got ${typeName(v)}`);
    return false;
  }
  if (opts.nonEmpty && v.trim() === "") ck.fail("INV-STRUCTURE", `${p}: empty string`);
  if (opts.pattern && !opts.pattern.test(v)) ck.fail("INV-STRUCTURE", `${p}: does not match the id pattern`);
  return true;
}

function enumField(ck: Checks, v: unknown, set: ReadonlySet<string>, p: string): boolean {
  if (typeof v === "string" && set.has(v)) return true;
  ck.fail("INV-STRUCTURE", `${p}: value outside the enum (${typeName(v)})`);
  return false;
}

function bool(ck: Checks, v: unknown, p: string): boolean {
  if (typeof v === "boolean") return true;
  ck.fail("INV-STRUCTURE", `${p}: expected boolean, got ${typeName(v)}`);
  return false;
}

/** An array: every element is visited by the caller; nothing is filtered out. */
function arr(ck: Checks, v: unknown, p: string, max: number): v is unknown[] {
  if (!Array.isArray(v)) {
    ck.fail("INV-STRUCTURE", `${p}: expected array, got ${typeName(v)}`);
    return false;
  }
  if (v.length > max) ck.fail("INV-STRUCTURE", `${p}: ${v.length} elements exceed ${max}`);
  return true;
}

// ---------------------------------------------------------------------------
// Evaluation of one case
// ---------------------------------------------------------------------------

export type EvaluateOptions = {
  /** "synthetic": the case carries a pipeline expectation and expected findings. */
  mode?: "synthetic" | "recorded";
};

export async function evaluateCase(c: EvalCase, subject: Subject = productionSubject, opts: EvaluateOptions = {}): Promise<CaseResult> {
  const run = await subject(c);
  return judge(c, run, opts);
}

export function judge(c: EvalCase, run: SubjectRun, opts: EvaluateOptions = {}): CaseResult {
  const mode = opts.mode ?? "synthetic";
  const ck = new Checks();
  const selected = c.input.allergens;
  const accepted = run.httpStatus === 200;
  const body = run.body;
  const logs = Array.isArray(run.logs) ? run.logs : [];
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : undefined;
  const rawFailure = isObj(lastLog) ? lastLog.failure : undefined;
  // Logged values are never copied: only known fixed codes are kept.
  const failure = rawFailure === undefined ? undefined : typeof rawFailure === "string" && KNOWN_FAILURE_CODES.has(rawFailure) ? rawFailure : "unrecognized_failure";

  // ---- log vocabulary (PR #18 re-audit MINOR-1) ----
  // An unknown failure value in ANY log event is a violation on its own, even if
  // everything else is correct. The value itself is never copied (index only).
  ck.applies("INV-LOG-VOCABULARY");
  if (!Array.isArray(run.logs)) ck.fail("INV-LOG-VOCABULARY", "logs are not a list");
  logs.forEach((e, i) => {
    if (!isObj(e)) return ck.fail("INV-LOG-VOCABULARY", `log event [${i}] is not an object`);
    if (!("failure" in e)) return;
    if (typeof e.failure !== "string" || !KNOWN_FAILURE_CODES.has(e.failure)) {
      ck.fail("INV-LOG-VOCABULARY", `log event [${i}] failure outside the known fixed vocabulary (${typeName(e.failure)})`);
    }
  });
  const rawCode = isObj(body) && isObj(body.error) ? body.error.code : undefined;
  const errorCode = rawCode === undefined ? undefined : safeEnum(rawCode, ERROR_CODES);
  const inputSupported = selected.every((a) => CODES.has(a)) && isSupportedPair(c.input.userLang, c.input.storeLang);

  ck.applies("INV-STRUCTURE");

  // ---- verdict keys anywhere in the body (success or error) ----
  ck.applies("INV-NO-VERDICT");
  walkKeys(body, "$", (k, parent) => {
    if (VERDICT_KEY.test(k)) ck.fail("INV-NO-VERDICT", `verdict-like key under ${parent}`);
  });

  // ---- fail-closed ----
  ck.applies("INV-FAIL-CLOSED");
  if (!accepted) {
    if (run.httpStatus < 400) ck.fail("INV-FAIL-CLOSED", `non-200 status ${run.httpStatus} is not an error status`);
    if (shape(ck, body, "error", "$")) {
      str(ck, body.requestId, "$.requestId");
      if (shape(ck, body.error, "errorInner", "$.error")) {
        enumField(ck, body.error.code, ERROR_CODES, "$.error.code");
        bool(ck, body.error.retryable, "$.error.retryable");
        if ("reason" in body.error) enumField(ck, body.error.reason, INPUT_REASONS, "$.error.reason");
      }
      const extra = Object.keys(body).filter((k) => k !== "requestId" && k !== "error").length;
      if (extra > 0) ck.fail("INV-FAIL-CLOSED", `error body carries ${extra} extra key(s) (possible partial result)`);
    } else ck.fail("INV-FAIL-CLOSED", "error body is not an object");
  } else if (mode === "synthetic" && c.expect?.outcome === "rejected") {
    ck.fail("INV-FAIL-CLOSED", "output that must be rejected was accepted (HTTP 200)");
  }

  // ---- model calls / network ----
  ck.applies("INV-MODEL-CALLS");
  if (run.networkCalls !== 0) ck.fail("INV-MODEL-CALLS", `network calls attempted: ${Number(run.networkCalls) || 0}`);
  const expectedCalls = inputSupported ? 1 : 0;
  if (run.modelCalls !== expectedCalls) ck.fail("INV-MODEL-CALLS", `model calls ${Number(run.modelCalls) || 0} (expected ${expectedCalls})`);

  // ---- unsupported allergens / language pairs ----
  ck.applies("INV-UNSUPPORTED");
  if (!inputSupported) {
    if (accepted) ck.fail("INV-UNSUPPORTED", "unsupported input was analysed");
    if (errorCode !== "INVALID_INPUT") ck.fail("INV-UNSUPPORTED", `unsupported input returned ${errorCode ?? "no error code"}`);
  }

  // ---- logs ----
  ck.applies("INV-NO-BODY-IN-LOGS");
  const logText = JSON.stringify(logs);
  for (const t of freeTextsOf(c.modelText)) {
    if (logText.includes(t) || logText.includes(JSON.stringify(t).slice(1, -1))) {
      ck.fail("INV-NO-BODY-IN-LOGS", "model free text found in log events");
      break;
    }
  }
  if (c.modelText.length >= 6 && logText.includes(c.modelText)) ck.fail("INV-NO-BODY-IN-LOGS", "raw model text found in log events");

  // ---- injection ----
  if (c.coverage.includes("prompt_injection")) {
    ck.applies("INV-INJECTION");
    walkKeys(body, "$", (k, parent) => {
      if (VERDICT_KEY.test(k)) ck.fail("INV-INJECTION", `injected verdict key passed under ${parent}`);
    });
    if (mode === "synthetic" && c.expect?.outcome === "rejected" && accepted) {
      ck.fail("INV-INJECTION", "output that followed an injected instruction was accepted");
    }
  }

  let view: AcceptedView = { items: [], notices: [], status: "<invalid>" };
  if (accepted) view = judgeAccepted(c, body, ck);

  // ---- pipeline expectation (regression) ----
  if (mode === "synthetic") {
    ck.applies("PIPELINE-EXPECTATION");
    const e = c.expect;
    if (!e) ck.fail("PIPELINE-EXPECTATION", "synthetic case without expectation");
    else if (e.outcome === "rejected") {
      if (accepted) ck.fail("PIPELINE-EXPECTATION", "expected rejected, got accepted");
      else {
        if (errorCode !== e.errorCode) ck.fail("PIPELINE-EXPECTATION", `errorCode ${errorCode ?? "none"} != ${e.errorCode}`);
        if (failure !== e.failure) ck.fail("PIPELINE-EXPECTATION", `failure ${failure ?? "none"} != ${e.failure ?? "none"}`);
        const rawReason = isObj(body) && isObj(body.error) ? body.error.reason : undefined;
        const reason = rawReason === undefined ? undefined : safeEnum(rawReason, INPUT_REASONS);
        if (reason !== e.reason) ck.fail("PIPELINE-EXPECTATION", `reason ${reason ?? "none"} != ${e.reason ?? "none"}`);
      }
    } else if (!accepted) {
      ck.fail("PIPELINE-EXPECTATION", `expected accepted, got ${errorCode ?? run.httpStatus}/${failure ?? "none"}`);
    } else {
      if (view.status !== e.status) ck.fail("PIPELINE-EXPECTATION", `status ${view.status} != ${e.status}`);
      if (view.items.length !== e.items.length) ck.fail("PIPELINE-EXPECTATION", `items ${view.items.length} != ${e.items.length}`);
      e.items.forEach((ei, i) => {
        for (const code of selected) {
          if (!(code in ei.labels)) ck.fail("PIPELINE-EXPECTATION", `case definition: items[${i}] lacks expectation for ${safeCode(code)}`);
        }
        const got = labelsOf(view.items[i]);
        for (const [code, want] of Object.entries(ei.labels)) {
          if (got[code] !== want) ck.fail("PIPELINE-EXPECTATION", `items[${i}].${safeCode(code)}: ${got[code] ?? "missing"} != ${want}`);
        }
      });
      if (view.notices.length !== e.notices.length) ck.fail("PIPELINE-EXPECTATION", `notices ${view.notices.length} != ${e.notices.length}`);
      e.notices.forEach((en, i) => {
        const got = noticeLabelsOf(view.notices[i]);
        const want = Object.fromEntries(Object.entries(en.mentions));
        if (JSON.stringify(sortObj(got)) !== JSON.stringify(sortObj(want))) ck.fail("PIPELINE-EXPECTATION", `menuNotices[${i}] mentions differ`);
      });
    }
  }

  // ---- accuracy axis (reference vs output) ----
  const findings: string[] = [];
  if (c.reference) {
    if (!accepted) findings.push("rejected_fail_closed");
    else {
      if (view.items.length !== c.reference.items.length) findings.push(`items_count ${view.items.length} != ${c.reference.items.length}`);
      c.reference.items.forEach((ref, i) => {
        const item = view.items[i];
        if (!isObj(item)) return;
        const rt = isObj(item.readText) && typeof item.readText.text === "string" ? item.readText.text : "";
        if (oracleNormalize(rt) !== oracleNormalize(ref.menuText)) findings.push(`items[${i}].readText_mismatch`);
        const got = labelsOf(item);
        for (const [code, want] of Object.entries(ref.labels)) {
          if (got[code] !== want) findings.push(`items[${i}].${safeCode(code)}: ${want} -> ${got[code] ?? "missing"}`);
        }
      });
    }
    findings.sort();
    if (mode === "synthetic") {
      ck.applies("ACCURACY-DETECTION");
      const want = [...(c.expectedFindings ?? [])].sort();
      if (JSON.stringify(want) !== JSON.stringify(findings)) {
        ck.fail("ACCURACY-DETECTION", `expected findings [${want.join(" | ")}] got [${findings.join(" | ")}]`);
      }
    }
  }

  for (const u of c.unverifiable ?? []) ck.unverified("OUTPUT-ONLY-UNDECIDABLE", `${u.id}: ${u.statement}`);

  const checks = ck.result();
  const status = checks.some((x) => x.status === "fail") ? "fail" : checks.some((x) => x.status === "unverified") ? "unverified" : "pass";
  return {
    id: c.id,
    title: c.title,
    coverage: c.coverage,
    status,
    observed: {
      httpStatus: Number.isInteger(run.httpStatus) ? run.httpStatus : 0,
      outcome: accepted ? "accepted" : "rejected",
      ...(errorCode ? { errorCode } : {}),
      ...(failure ? { failure } : {}),
      modelCalls: Number(run.modelCalls) || 0,
    },
    checks,
    accuracyFindings: findings,
  };
}

function sortObj(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** Labels by code; an entry that is not an object or has an unknown code is recorded under "<invalid>". */
function labelsOf(item: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(item) || !Array.isArray(item.allergens)) return out;
  for (const a of item.allergens) {
    const code = isObj(a) ? safeCode(a.code) : "<invalid>";
    out[code] = out[code] === undefined ? labelOf(a) : "duplicate";
  }
  return out;
}

function noticeLabelsOf(n: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(n) || !Array.isArray(n.mentions)) return out;
  for (const m of n.mentions) {
    const code = isObj(m) ? safeCode(m.code) : "<invalid>";
    const kind = isObj(m) ? safeEnum(m.kind, KINDS) : "<invalid>";
    out[code] = out[code] === undefined ? `menu_mentions:${kind}` : "duplicate";
  }
  return out;
}

type AcceptedView = { items: unknown[]; notices: unknown[]; status: string };

/**
 * Checks a successful response. EVERY element of every array is visited:
 * nothing is filtered out, so a null / malformed element is a failure
 * (fail-closed), never silently skipped (PR #18 audit MAJOR-1).
 */
function judgeAccepted(c: EvalCase, body: unknown, ck: Checks): AcceptedView {
  const selected = c.input.allergens;
  const selectedSet = new Set(selected);
  for (const id of [
    "INV-CONFIRMATION",
    "INV-PROVENANCE",
    "INV-COVERAGE",
    "INV-THREE-CATEGORIES",
    "INV-MENTION-KIND",
    "INV-NO-ABSENCE-INFERENCE",
    "INV-EXCERPT-CONSISTENCY",
  ] as const) {
    ck.applies(id);
  }
  if (!shape(ck, body, "response", "$")) {
    ck.fail("INV-FAIL-CLOSED", "accepted body is not an object");
    return { items: [], notices: [], status: "<invalid>" };
  }
  str(ck, body.requestId, "$.requestId");
  enumField(ck, body.status, STATUSES, "$.status");
  if (enumField(ck, body.dataOrigin, DATA_ORIGINS, "$.dataOrigin") && body.dataOrigin !== "ai_analysis") {
    ck.fail("INV-PROVENANCE", "dataOrigin is not ai_analysis");
  }
  if (body.requestId !== requestIdFor(c)) ck.fail("INV-PROVENANCE", "requestId is not the server's");
  if (arr(ck, body.imageIssues, "$.imageIssues", 4)) body.imageIssues.forEach((x, i) => enumField(ck, x, IMAGE_ISSUES, `$.imageIssues[${i}]`));
  const items = arr(ck, body.items, "$.items", 30) ? body.items : [];
  const notices = arr(ck, body.menuNotices, "$.menuNotices", 10) ? body.menuNotices : [];
  const status = safeEnum(body.status, STATUSES);

  // The synthetic model output this response was produced from (accepted ⇒ it parsed strictly).
  let model: Obj | undefined;
  try {
    const v: unknown = JSON.parse(c.modelText);
    if (isObj(v)) model = v;
  } catch {
    ck.fail("INV-FAIL-CLOSED", "unparseable model text was accepted");
  }
  const modelItems: unknown[] = model && Array.isArray(model.items) ? model.items : [];
  const modelNotices: unknown[] = model && Array.isArray(model.menuNotices) ? model.menuNotices : [];
  if (model && items.length !== modelItems.length) ck.fail("INV-COVERAGE", `items ${items.length} != model items ${modelItems.length}`);
  if (model && notices.length !== modelNotices.length) ck.fail("INV-COVERAGE", `notices ${notices.length} != model notices ${modelNotices.length}`);

  const checkWording = (text: string, p: string, kind: "translation" | "rationale") => {
    ck.applies("INV-FREE-TEXT-VERDICT");
    if (!VERDICT_WORDING.some((re) => re.test(text))) return;
    if (kind === "rationale") {
      // A rationale is the AI's own reasoning, never a transcription. A hit is
      // reported as FAIL for human review; string matching alone never proves a verdict.
      ck.fail("INV-FREE-TEXT-VERDICT", `${p} contains verdict-like wording (auxiliary string match; needs human review)`);
    } else {
      ck.unverified("INV-FREE-TEXT-VERDICT", `${p} contains verdict-like wording (translation of printed text or AI assertion: undecidable from output)`);
    }
  };
  const checkReadText = (rt: unknown, p: string, modelReadText: unknown) => {
    if (!shape(ck, rt, "readText", `${p}.readText`)) return;
    str(ck, rt.text, `${p}.readText.text`, { nonEmpty: true });
    if (rt.lang !== null && !isContractLanguageTag(rt.lang)) {
      ck.fail("INV-STRUCTURE", `${p}.readText.lang: not a valid language tag or null (${typeName(rt.lang)})`);
    }
    if (rt.readBy !== "ai") ck.fail("INV-PROVENANCE", `${p}.readText.readBy is not "ai" (${typeName(rt.readBy)})`);
    if (model && rt.text !== modelReadText) ck.fail("INV-PROVENANCE", `${p}.readText was altered by post-processing`);
  };
  const checkTranslation = (tr: unknown, p: string) => {
    if (tr === null) return;
    if (!shape(ck, tr, "translation", `${p}.aiTranslation`)) return;
    const textOk = str(ck, tr.text, `${p}.aiTranslation.text`, { nonEmpty: true });
    if (!isContractLanguageTag(tr.lang)) ck.fail("INV-STRUCTURE", `${p}.aiTranslation.lang: not a valid language tag (${typeName(tr.lang)})`);
    if (tr.verified !== false) ck.fail("INV-PROVENANCE", `${p}.aiTranslation.verified is not false (${typeName(tr.verified)})`);
    if (tr.lang !== c.input.userLang) ck.fail("INV-PROVENANCE", `${p}.aiTranslation.lang is not the user language`);
    if (textOk) checkWording(tr.text as string, `${p}.aiTranslation`, "translation");
  };

  items.forEach((item, i) => {
    const p = `items[${i}]`;
    const mItem = isObj(modelItems[i]) ? (modelItems[i] as Obj) : undefined;
    if (!shape(ck, item, "item", p)) {
      ck.fail("INV-COVERAGE", `${p} is not a dish entry`);
      return;
    }
    str(ck, item.id, `${p}.id`, { pattern: ID_PATTERN });
    enumField(ck, item.readability, READABILITY, `${p}.readability`);
    checkReadText(item.readText, p, mItem?.readText);
    if ("aiTranslation" in item) checkTranslation(item.aiTranslation, p);
    const readText = isObj(item.readText) && typeof item.readText.text === "string" ? item.readText.text : "";
    if (!arr(ck, item.allergens, `${p}.allergens`, ALLERGEN_CODES.length)) {
      ck.fail("INV-COVERAGE", `${p}.allergens is not a list`);
      return;
    }
    const assessments = item.allergens;

    // coverage: each selected code exactly once, nothing else; non-objects count as invalid entries
    const counts = new Map<string, number>();
    for (const a of assessments) {
      const code = isObj(a) && typeof a.code === "string" ? a.code : "<invalid>";
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    for (const code of selected) {
      const n = counts.get(code) ?? 0;
      if (n !== 1) ck.fail("INV-COVERAGE", `${p}.${safeCode(code)} assessed ${n} times`);
    }
    for (const code of counts.keys()) if (!selectedSet.has(code)) ck.fail("INV-COVERAGE", `${p}: an entry with code ${safeCode(code)} that was not selected`);

    // the model's own labels for selected codes
    const modelLabels = new Map<string, string>();
    const mAllergens: unknown[] = mItem && Array.isArray(mItem.allergens) ? mItem.allergens : [];
    for (const ma of mAllergens) if (isObj(ma) && typeof ma.code === "string" && selectedSet.has(ma.code)) modelLabels.set(ma.code, modelLabelOf(ma));

    assessments.forEach((a, j) => {
      const ap = `${p}.allergens[${j}]`;
      if (!isObj(a)) {
        ck.fail("INV-STRUCTURE", `${ap}: expected assessment object, got ${typeName(a)}`);
        ck.fail("INV-CONFIRMATION", `${ap} is not an assessment (no confirmationRequired)`);
        return;
      }
      const codeOk = enumField(ck, a.code, CODES, `${ap}.code`);
      if (!codeOk) ck.fail("INV-UNSUPPORTED", `${ap} unsupported or invalid code`);
      const code = codeOk ? (a.code as string) : "<invalid>";
      if (a.confirmationRequired !== true) ck.fail("INV-CONFIRMATION", `${ap}.confirmationRequired is not true (${typeName(a.confirmationRequired)})`);
      if (typeof a.category !== "string" || !CATEGORIES.has(a.category)) {
        ck.fail("INV-STRUCTURE", `${ap}.category: value outside the enum (${typeName(a.category)})`);
        ck.fail("INV-THREE-CATEGORIES", `${ap} category outside the three categories`);
        ck.fail("INV-NO-VERDICT", `${ap} category outside the three categories`);
        return;
      }
      shape(ck, a, a.category as Shape, ap);
      if (a.category === "menu_mentions") {
        if (!shape(ck, a.mention, "mention", `${ap}.mention`)) ck.fail("INV-MENTION-KIND", `${ap}.mention missing or malformed`);
        else {
          const m = a.mention;
          if (!enumField(ck, m.kind, KINDS, `${ap}.mention.kind`)) ck.fail("INV-MENTION-KIND", `${ap} unknown mention kind`);
          if (str(ck, m.excerpt, `${ap}.mention.excerpt`, { nonEmpty: true })) {
            const excerpt = m.excerpt as string;
            if (!/[\p{L}\p{N}]/u.test(excerpt)) ck.fail("INV-EXCERPT-CONSISTENCY", `${ap} excerpt has no letter or digit`);
            if (oracleNormalize(excerpt) === "" || !oracleNormalize(readText).includes(oracleNormalize(excerpt))) {
              ck.fail("INV-EXCERPT-CONSISTENCY", `${ap} excerpt not contained in readText`);
            }
          } else ck.fail("INV-EXCERPT-CONSISTENCY", `${ap} excerpt missing or not a string`);
        }
      }
      if (a.category === "ai_inferred") {
        if (str(ck, a.rationale, `${ap}.rationale`, { nullable: true, nonEmpty: true }) && typeof a.rationale === "string") {
          checkWording(a.rationale, `${ap}.rationale`, "rationale");
        }
      }
      if (a.category === "unconfirmed" && !enumField(ck, a.reason, REASONS, `${ap}.reason`)) {
        ck.fail("INV-NO-ABSENCE-INFERENCE", `${ap} unknown unconfirmed reason`);
      }

      // preservation against the model's own statement
      if (!model || !selectedSet.has(code)) return;
      const got = labelOf(a);
      const want = modelLabels.get(code);
      if (want === undefined) {
        if (got !== "unconfirmed:not_assessed") {
          ck.fail("INV-NO-ABSENCE-INFERENCE", `${ap} not returned by the model but became ${got} (must be unconfirmed:not_assessed)`);
        }
        return;
      }
      if (got === want) return;
      const gotCat = got.split(":")[0];
      const wantCat = want.split(":")[0];
      if (gotCat !== wantCat) ck.fail("INV-THREE-CATEGORIES", `${ap} category changed ${want} -> ${got}`);
      else if (wantCat === "menu_mentions") ck.fail("INV-MENTION-KIND", `${ap} mention kind changed ${want} -> ${got}`);
      else ck.fail("INV-NO-ABSENCE-INFERENCE", `${ap} unconfirmed reason changed ${want} -> ${got}`);
      if (want === "menu_mentions:absence_claim") ck.fail("INV-MENTION-KIND", `${ap} absence_claim was converted`);
    });
  });

  notices.forEach((n, i) => {
    const p = `menuNotices[${i}]`;
    if (!shape(ck, n, "notice", p)) {
      ck.fail("INV-MENTION-KIND", `${p} is not a notice`);
      return;
    }
    const mNotice = isObj(modelNotices[i]) ? (modelNotices[i] as Obj) : undefined;
    str(ck, n.id, `${p}.id`, { pattern: ID_PATTERN });
    checkReadText(n.readText, p, mNotice?.readText);
    if ("aiTranslation" in n) checkTranslation(n.aiTranslation, p);
    if (!arr(ck, n.mentions, `${p}.mentions`, ALLERGEN_CODES.length)) {
      ck.fail("INV-MENTION-KIND", `${p}.mentions is not a list`);
      return;
    }
    const got: string[] = [];
    n.mentions.forEach((m, j) => {
      const mp = `${p}.mentions[${j}]`;
      if (!shape(ck, m, "noticeMention", mp)) {
        ck.fail("INV-MENTION-KIND", `${mp} is not a mention`);
        got.push("<invalid>");
        return;
      }
      if (!enumField(ck, m.code, CODES, `${mp}.code`)) ck.fail("INV-UNSUPPORTED", `${mp} unsupported or invalid code`);
      else if (!selectedSet.has(m.code as string)) ck.fail("INV-COVERAGE", `${mp} code was not selected`);
      if (!enumField(ck, m.kind, KINDS, `${mp}.kind`)) ck.fail("INV-MENTION-KIND", `${mp} unknown kind`);
      got.push(`${safeCode(m.code)}:${safeEnum(m.kind, KINDS)}`);
    });
    if (model && mNotice) {
      const want = (Array.isArray(mNotice.mentions) ? mNotice.mentions : [])
        .map((m) => (isObj(m) ? `${safeCode(m.code)}:${safeEnum(m.kind, KINDS)}` : "<invalid>"))
        .filter((s) => selectedSet.has(s.split(":")[0]!))
        .sort();
      if (JSON.stringify(want) !== JSON.stringify([...got].sort())) ck.fail("INV-MENTION-KIND", `${p} mentions changed by post-processing`);
    }
  });

  return { items, notices, status };
}
