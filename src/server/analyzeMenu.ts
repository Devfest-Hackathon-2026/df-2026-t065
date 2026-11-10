import {
  AnalyzeMenuErrorSchema,
  ERROR_HTTP_STATUS,
  makeError,
  parseAnalyzeMenuForm,
  type AnalyzeMenuError,
  type AnalyzeMenuResponse,
  type ErrorCode,
  type InvalidInputReason,
} from "@/contracts/analyze";
import { readGeminiConfig, type AiEnv, type GeminiConfig } from "./config";
import { analyzeWithGemini, type RunnerDeps } from "./gemini/analyzeWithGemini";
import { getVertexMenuModel, type MenuModel } from "./gemini/vertexClient";
import { consoleLogger, type LogEvent, type Logger } from "./log";
import { MOCK_FIXTURES, isMockScenario } from "./mockFixtures";
import { finalizeCandidate } from "./pipeline";
import { readBoundedMultipart, verifyImage } from "./requestBody";
import { UsageGuard, clientKey, isKillSwitchOn, readUsageConfig } from "./usage/guard";
import type { UsageStore } from "./usage/store";

/*
 * POST /api/analyze-menu
 *
 *  1. Bounded body read (Content-Length is not trusted) → multipart parse
 *  2. Contract field validation (parseAnalyzeMenuForm)
 *  3. Image verification (size + magic bytes must match the declared type)
 *  4a. Mock mode (development/test only): SYNTHETIC fixtures, dataOrigin "mock_fixture"
 *  4b. Otherwise the real Gemini path, guarded (PR5, all fail closed):
 *      kill switch (GEMINI_ENABLED === "true") → Vertex config → usage store/limits
 *      → per-client rate limit (RATE_LIMITED) → one daily-cap reservation before
 *      EVERY model call, the retry included (cap reached → AI_DISABLED, 0 calls)
 *  5. Every result goes through the same validation pipeline (pipeline.ts)
 *
 * The daily cap limits the number of model calls, not the bill. A shared usage
 * store is required in production; until one is approved and configured, the real
 * Gemini path stays disabled there (see docs/DECISIONS.md D-010).
 */

export type AnalyzeEnv = AiEnv & { NODE_ENV?: string; MOCK_GEMINI?: string } & Record<string, string | undefined>;

/** Mock mode is impossible in production, whatever MOCK_GEMINI says. */
export function isMockModeEnabled(env: AnalyzeEnv): boolean {
  return env.NODE_ENV !== "production" && env.MOCK_GEMINI === "true";
}

/** Header that selects a fixture in mock mode (ignored otherwise). */
export const MOCK_SCENARIO_HEADER = "x-mock-scenario";

export type AnalyzeDeps = RunnerDeps & {
  newRequestId?: () => string;
  logger?: Logger;
  /** Test seam: replaces the Vertex AI model. */
  model?: MenuModel;
  /** Test seam: replaces the configuration read from env (bypasses env bounds). */
  config?: GeminiConfig;
  /** Test seam: replaces the usage guard read from env (the kill switch still applies). */
  usage?: UsageGuard;
  /** Test seam: store factories by USAGE_STORE name (defaults to the built-in ones). */
  usageStores?: Record<string, () => UsageStore>;
};

export async function handleAnalyzeMenu(req: Request, env: AnalyzeEnv, deps: AnalyzeDeps = {}): Promise<Response> {
  const requestId = (deps.newRequestId ?? (() => crypto.randomUUID()))();
  const log = deps.logger ?? consoleLogger;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const mock = isMockModeEnabled(env);
  const finish = (res: Response, e: Omit<LogEvent, "event" | "requestId" | "latencyMs" | "mock">) => {
    log({ event: "analyze_menu", requestId, latencyMs: now() - started, mock, ...e });
    return res;
  };
  const invalid = (reason: InvalidInputReason) =>
    finish(errorResponse(requestId, "INVALID_INPUT", reason), { outcome: "error", errorCode: "INVALID_INPUT", reason });

  // card_only rejects before touching the body, config, ADC, or usage store.
  // Production never enters Mock, including when MOCK_GEMINI is misconfigured.
  if (!mock && isKillSwitchOn(env)) {
    return finish(errorResponse(requestId, "AI_DISABLED"), {
      outcome: "error", errorCode: "AI_DISABLED", failure: "kill_switch_off",
    });
  }

  const body = await readBoundedMultipart(req);
  if (!body.ok) return invalid(body.reason);
  const parsed = parseAnalyzeMenuForm(body.form);
  if (!parsed.ok) return invalid(parsed.reason);
  const image = await verifyImage(parsed.image);
  if (!image.ok) return invalid(image.reason);
  const selected = parsed.fields.allergens;

  if (mock) {
    const scenario = req.headers.get(MOCK_SCENARIO_HEADER) ?? "ok";
    if (!isMockScenario(scenario)) return invalid("malformed_request");
    const fixture = MOCK_FIXTURES[scenario];
    if (fixture.kind === "error") {
      const err = AnalyzeMenuErrorSchema.parse({ ...fixture.body, requestId });
      return finish(json(err, ERROR_HTTP_STATUS[err.error.code]), { outcome: "error", errorCode: err.error.code, failure: "mock_error" });
    }
    const result = finalizeCandidate(fixture.body, selected, { requestId, dataOrigin: "mock_fixture" });
    if (!result.ok) {
      return finish(errorResponse(requestId, "AI_FAILED"), { outcome: "error", errorCode: "AI_FAILED", failure: result.failure });
    }
    return finish(ok(result.body), { outcome: "ok" });
  }

  const disabled = (failure: string) =>
    finish(errorResponse(requestId, "AI_DISABLED"), { outcome: "error", errorCode: "AI_DISABLED", failure });

  // Kill switch first: when off, nothing below runs and no SDK client is created.
  if (isKillSwitchOn(env)) return disabled("kill_switch_off");

  const configResult = deps.config ? { ok: true as const, config: deps.config } : readGeminiConfig(env);
  if (!configResult.ok) {
    // Fixed enum values only — never the variable names' values, URLs or project IDs.
    return disabled(configResult.blocked.length > 0 ? "endpoint_override_blocked" : "not_configured");
  }

  // One absolute deadline from here on (input validation is done): store
  // initialisation, the rate check, every reservation, backoff and every model
  // call all spend it.
  const deadlineAt = now() + configResult.config.requestDeadlineMs;

  let guard = deps.usage;
  if (!guard) {
    const usage = readUsageConfig(env, deps.usageStores);
    if (!usage.ok) return disabled(usage.failure);
    guard = new UsageGuard(usage.store, usage.limits, now);
  }

  const rate = await guard.checkRate(clientKey(req, guard.limits.trustedProxyHops), deadlineAt);
  if (rate === "limited") {
    return finish(errorResponse(requestId, "RATE_LIMITED"), { outcome: "error", errorCode: "RATE_LIMITED", failure: "rate_limited" });
  }
  if (rate === "store_error") return disabled("usage_store_error");
  if (rate === "store_timeout") return disabled("usage_store_timeout");
  // The rate unit was consumed, but too late to act on (deadline already spent).
  if (rate === "allowed_late") return disabled("rate_check_late");

  const model = deps.model ?? getVertexMenuModel(configResult.config);
  const usageGuard = guard;
  const outcome = await analyzeWithGemini(
    model,
    configResult.config,
    { image: image.bytes, mimeType: image.mimeType, userLang: parsed.fields.userLang, storeLang: parsed.fields.storeLang, allergens: selected },
    { requestId, deadlineAt, reserveAttempt: (deadline) => usageGuard.reserveInference(deadline) },
    deps,
  );
  if (outcome.ok) {
    return finish(ok(outcome.body), {
      outcome: "ok",
      attempts: outcome.attempts,
      reserved: outcome.reserved,
      reservationsUnknown: outcome.reservationsUnknown,
      reservationsRolledOver: outcome.reservationsRolledOver,
      finishReason: outcome.finishReason,
    });
  }
  return finish(errorResponse(requestId, outcome.code), {
    outcome: "error",
    errorCode: outcome.code,
    failure: outcome.failure,
    attempts: outcome.attempts,
    reserved: outcome.reserved,
    reservationsUnknown: outcome.reservationsUnknown,
    reservationsRolledOver: outcome.reservationsRolledOver,
    limitReason: outcome.limitReason,
    upstreamStatus: outcome.upstreamStatus,
    finishReason: outcome.finishReason,
  });
}

function ok(body: AnalyzeMenuResponse): Response {
  return json(body, 200);
}

function errorResponse(requestId: string, code: ErrorCode, reason?: InvalidInputReason): Response {
  const body: AnalyzeMenuError = makeError(requestId, code, reason);
  return json(body, ERROR_HTTP_STATUS[code]);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
