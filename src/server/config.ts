/*
 * Runtime configuration for Gemini on Vertex AI (read from environment variables).
 *
 * No model ID or region is hard-coded: the official model list, regional
 * availability and pricing could not be confirmed from this development session
 * and must be confirmed (and approved) before any Google Cloud work. Until all
 * required values are set, AI analysis is disabled (AI_DISABLED).
 *
 * Authentication: Application Default Credentials only (Cloud Run service
 * account at runtime). No API keys, no service-account JSON keys.
 */

export type AiEnv = {
  GOOGLE_CLOUD_PROJECT?: string;
  GOOGLE_CLOUD_LOCATION?: string;
  GEMINI_MODEL?: string;
  GEMINI_ATTEMPT_TIMEOUT_MS?: string;
  GEMINI_REQUEST_DEADLINE_MS?: string;
  GEMINI_MAX_OUTPUT_TOKENS?: string;
};

export type GeminiConfig = {
  project: string;
  location: string;
  model: string;
  /** Timeout for one model call. */
  attemptTimeoutMs: number;
  /** Upper bound for the whole analysis (all attempts + backoff). */
  requestDeadlineMs: number;
  maxOutputTokens: number;
};

/**
 * Proposed defaults (to be approved together with cost limits; see docs/DECISIONS.md D-008):
 *  - attempt timeout 20 s: a single image + JSON answer from a Flash-class model is expected
 *    to take seconds (NOT yet measured); 20 s leaves margin without leaving users waiting.
 *  - request deadline 45 s: allows at most one retry (2 × 20 s + backoff) and stays well
 *    under the Cloud Run default request timeout.
 *  - max output tokens 8192: 30 items × 11 allergens of compact JSON fits; also caps cost.
 */
export const GEMINI_DEFAULTS = {
  attemptTimeoutMs: 20_000,
  requestDeadlineMs: 45_000,
  maxOutputTokens: 8_192,
} as const;

const BOUNDS = {
  attemptTimeoutMs: [5_000, 60_000],
  requestDeadlineMs: [5_000, 120_000],
  maxOutputTokens: [1_024, 16_384],
} as const;

export type ConfigResult =
  | { ok: true; config: GeminiConfig }
  | { ok: false; missing: string[]; blocked: string[] };

/**
 * Environment variables that make @google/genai 2.30.0 send requests — with the
 * ADC bearer token — to a different host (checked in the SDK: getEnv calls).
 * Their presence disables AI analysis. Matching is case-insensitive, so a
 * lower-case variant is refused too (on platforms with case-insensitive env).
 * Empty / whitespace-only values are ignored, exactly as the SDK ignores them.
 * Values are never logged or returned.
 */
export const SDK_ENDPOINT_OVERRIDE_VARS = ["GOOGLE_VERTEX_BASE_URL", "GOOGLE_GEMINI_BASE_URL"] as const;

export function findEndpointOverrides(env: Record<string, string | undefined>): string[] {
  const wanted = new Set<string>(SDK_ENDPOINT_OVERRIDE_VARS);
  return Object.keys(env).filter((k) => wanted.has(k.toUpperCase()) && (env[k] ?? "").trim() !== "");
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function readGeminiConfig(env: AiEnv & Record<string, string | undefined>): ConfigResult {
  const blocked = findEndpointOverrides(env);
  const project = env.GOOGLE_CLOUD_PROJECT?.trim() ?? "";
  const location = env.GOOGLE_CLOUD_LOCATION?.trim() ?? "";
  const model = env.GEMINI_MODEL?.trim() ?? "";
  const missing: string[] = [];
  if (!ID_PATTERN.test(project)) missing.push("GOOGLE_CLOUD_PROJECT");
  if (!ID_PATTERN.test(location)) missing.push("GOOGLE_CLOUD_LOCATION");
  if (!ID_PATTERN.test(model)) missing.push("GEMINI_MODEL");
  if (missing.length > 0 || blocked.length > 0) return { ok: false, missing, blocked };

  const attemptTimeoutMs = bounded(env.GEMINI_ATTEMPT_TIMEOUT_MS, GEMINI_DEFAULTS.attemptTimeoutMs, BOUNDS.attemptTimeoutMs);
  const requestDeadlineMs = Math.max(
    attemptTimeoutMs,
    bounded(env.GEMINI_REQUEST_DEADLINE_MS, GEMINI_DEFAULTS.requestDeadlineMs, BOUNDS.requestDeadlineMs),
  );
  const maxOutputTokens = bounded(env.GEMINI_MAX_OUTPUT_TOKENS, GEMINI_DEFAULTS.maxOutputTokens, BOUNDS.maxOutputTokens);
  return { ok: true, config: { project, location, model, attemptTimeoutMs, requestDeadlineMs, maxOutputTokens } };
}

function bounded(raw: string | undefined, fallback: number, [min, max]: readonly [number, number]): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Math.min(max, Math.max(min, Number(raw.trim())));
}
