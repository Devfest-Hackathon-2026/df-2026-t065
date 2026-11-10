import type { AllergenCode } from "@/contracts/allergens";
import {
  AnalyzeMenuErrorSchema,
  AnalyzeMenuResponseSchema,
  checkResponseInvariants,
  makeError,
  parseAnalyzeMenuForm,
  type AnalyzeMenuError,
  type AnalyzeMenuResponse,
} from "@/contracts/analyze";

export const MOCK_SCENARIO_HEADER_NAME = "x-mock-scenario";

/**
 * Default client-side request deadline (ms).
 * Aligned with backend GEMINI_DEFAULTS.requestDeadlineMs (45,000 ms) + 5,000 ms transport margin.
 */
export const DEFAULT_CLIENT_REQUEST_DEADLINE_MS = 50_000;

export const DEV_MOCK_SCENARIOS = [
  {
    id: "ok",
    labelJa: "ok — 標準（英語メニュー3品・記載/推測/未確認）",
    labelEn: "ok — Normal (3 English dishes: mentions, inferred, unconfirmed)",
  },
  {
    id: "negation_claims",
    labelJa: "negation_claims — 否定表現（peanut-free 等の不使用主張と含有の区別）",
    labelEn: "negation_claims — Negation claims (peanut-free vs contains vs may contain)",
  },
  {
    id: "cross_contact_notice",
    labelJa: "cross_contact_notice — 交差接触・揚げ油共有の全体注意書き（日本語メニュー）",
    labelEn: "cross_contact_notice — Shared fryer menu-wide notice (Japanese menu)",
  },
  {
    id: "partial",
    labelJa: "partial — 一部判読不能（照明・見切れによる partial 状態）",
    labelEn: "partial — Partially readable menu with image issues",
  },
  {
    id: "unreadable",
    labelJa: "unreadable — 判読不能（ピンボケ等で料理項目0件）",
    labelEn: "unreadable — Unreadable image (0 items)",
  },
  {
    id: "no_allergen_mentions",
    labelJa: "no_allergen_mentions — アレルゲン記載なし（全項目 unconfirmed）",
    labelEn: "no_allergen_mentions — No allergen mentions (all unconfirmed)",
  },
  {
    id: "injection_in_image",
    labelJa: "injection_in_image — 画像内プロンプト注入耐性（データを命令として実行しない）",
    labelEn: "injection_in_image — Prompt injection text inside image treated as data",
  },
  {
    id: "error_ai_timeout",
    labelJa: "error_ai_timeout — エラー検証：タイムアウト（504 AI_TIMEOUT）",
    labelEn: "error_ai_timeout — Error test: Timeout (504 AI_TIMEOUT)",
  },
  {
    id: "invalid_output_raw",
    labelJa: "invalid_output_raw — エラー検証：不正AI出力の遮断（502 AI_FAILED）",
    labelEn: "invalid_output_raw — Error test: Schema violation blocked (502 AI_FAILED)",
  },
  {
    id: "conflicting_assessments_raw",
    labelJa: "conflicting_assessments_raw — エラー検証：重複・矛盾評価の遮断（502 AI_FAILED）",
    labelEn: "conflicting_assessments_raw — Error test: Conflicting assessments blocked (502 AI_FAILED)",
  },
  {
    id: "invisible_evidence_raw",
    labelJa: "invisible_evidence_raw — エラー検証：不可視文字抜粋の遮断（502 AI_FAILED）",
    labelEn: "invisible_evidence_raw — Error test: Invisible evidence blocked (502 AI_FAILED)",
  },
] as const;

export type DevMockScenarioId = (typeof DEV_MOCK_SCENARIOS)[number]["id"];

export function isDevMockPanelAllowed(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production";
}

export type AnalyzeMenuClientResult =
  | { ok: true; data: AnalyzeMenuResponse }
  | { ok: false; error: AnalyzeMenuError; aborted?: boolean };

export type AnalyzeMenuRequestParams = {
  userLang: string;
  storeLang: string;
  allergens: readonly AllergenCode[];
  image: Blob;
  mockScenario?: DevMockScenarioId;
  nodeEnv?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Builds a strict multipart FormData matching ANALYZE_FORM_FIELDS.
 */
export function buildAnalyzeMenuFormData(params: {
  userLang: string;
  storeLang: string;
  allergens: readonly AllergenCode[];
  image: Blob;
}): FormData {
  const form = new FormData();
  form.append("userLang", params.userLang);
  form.append("storeLang", params.storeLang);
  for (const code of params.allergens) {
    form.append("allergens", code);
  }
  const ext = params.image.type === "image/png" ? "png" : params.image.type === "image/webp" ? "webp" : "jpg";
  form.append("image", params.image, `menu.${ext}`);
  return form;
}

/**
 * Submits the menu image and user settings to POST /api/analyze-menu.
 * - Pre-validates FormData against the shared contract.
 * - Enforces an AbortController + deadline timer; never treats aborts or timeouts as success.
 * - Accepts ONLY HTTP 200 as a candidate success response (201/202/206 etc. are rejected as AI_FAILED).
 * - Validates the response body against AnalyzeMenuResponseSchema and checkResponseInvariants.
 * - Performs no automatic retries.
 */
export async function submitAnalyzeMenu(params: AnalyzeMenuRequestParams): Promise<AnalyzeMenuClientResult> {
  if (params.signal?.aborted) {
    return {
      ok: false,
      aborted: true,
      error: makeError("client-aborted", "AI_FAILED"),
    };
  }

  const form = buildAnalyzeMenuFormData(params);
  const precheck = parseAnalyzeMenuForm(form);
  if (!precheck.ok) {
    return {
      ok: false,
      error: makeError("client-precheck", "INVALID_INPUT", precheck.reason),
    };
  }

  const headers: Record<string, string> = {};
  const effectiveEnv = params.nodeEnv ?? process.env.NODE_ENV;
  if (isDevMockPanelAllowed(effectiveEnv) && params.mockScenario) {
    headers[MOCK_SCENARIO_HEADER_NAME] = params.mockScenario;
  }

  const deadlineMs = params.timeoutMs ?? DEFAULT_CLIENT_REQUEST_DEADLINE_MS;
  // performance.now is monotonic: wall-clock changes cannot extend the deadline.
  const startedAt = performance.now();
  const expiresAt = startedAt + deadlineMs;
  const internalController = new AbortController();
  let timedOut = false;
  const hasExpired = () => timedOut || performance.now() >= expiresAt;
  const timeoutResult = (): AnalyzeMenuClientResult => ({
    ok: false, error: makeError("client-timeout", "AI_TIMEOUT"),
  });
  const abortResult = (): AnalyzeMenuClientResult => ({
    ok: false, aborted: true, error: makeError("client-aborted", "AI_FAILED"),
  });
  const checkDeadline = () => {
    if (params.signal?.aborted || hasExpired()) {
      internalController.abort();
      throw new Error("Request no longer current");
    }
  };

  // Settle even if fetch/body promises ignore AbortSignal or never resolve.
  let cancel!: (result: AnalyzeMenuClientResult) => void;
  const cancelled = new Promise<AnalyzeMenuClientResult>((resolve) => { cancel = resolve; });
  const onCallerAbort = () => {
    internalController.abort();
    cancel(abortResult());
  };
  params.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    internalController.abort();
    cancel(timeoutResult());
  }, deadlineMs);

  const execute = async (): Promise<AnalyzeMenuClientResult> => {
    let stage = "network-error";
    try {
      checkDeadline();
      const response = await (params.fetchImpl ?? fetch)("/api/analyze-menu", {
        method: "POST", body: form, headers, signal: internalController.signal,
      });
      checkDeadline();
      stage = "invalid-json";
      const rawBody: unknown = await response.json();
      checkDeadline();
      // Only HTTP 200 is a valid success status for POST /api/analyze-menu.
      // Other 2xx statuses (201, 202, 206, etc.) and all non-200 responses are rejected.
      if (response.status !== 200) {
        const parsedError = AnalyzeMenuErrorSchema.safeParse(rawBody);
        checkDeadline();
        if (parsedError.success) {
          return { ok: false, error: parsedError.data };
        }
        return {
          ok: false,
          error: makeError("client-non-200-status", "AI_FAILED"),
        };
      }

      const parsedResponse = AnalyzeMenuResponseSchema.safeParse(rawBody);
      checkDeadline();
      if (!parsedResponse.success) {
        return {
          ok: false,
          error: makeError("client-schema-violation", "AI_FAILED"),
        };
      }

      // Client-side defense in depth: never display mock data if running in production
      if (effectiveEnv === "production" && parsedResponse.data.dataOrigin === "mock_fixture") {
        return {
          ok: false,
          error: makeError(parsedResponse.data.requestId, "AI_FAILED"),
        };
      }

      // Verify cross-field invariants (all selected allergens present once, no conflicts, excerpt in readText)
      const violations = checkResponseInvariants(parsedResponse.data, precheck.fields.allergens);
      checkDeadline();
      if (violations.length > 0) {
        return {
          ok: false,
          error: makeError(parsedResponse.data.requestId, "AI_FAILED"),
        };
      }

      checkDeadline();
      return {
        ok: true,
        data: parsedResponse.data,
      };
    } catch {
      if (params.signal?.aborted) return abortResult();
      if (hasExpired()) return timeoutResult();
      return { ok: false, error: makeError(`client-${stage}`, "AI_FAILED") };
    }
  };

  try {
    const result = await Promise.race([execute(), cancelled]);
    if (params.signal?.aborted) return abortResult();
    if (hasExpired()) return timeoutResult();
    return result;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onCallerAbort);
  }
}
