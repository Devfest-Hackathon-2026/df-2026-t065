import type { AnalyzeMenuResponse, ErrorCode } from "@/contracts/analyze";
import type { GeminiConfig } from "../config";
import { types } from "node:util";
import { ClockError, isValidTimeMs, readTime, tryReadTime } from "../time";
import { settleUntrusted } from "../untrusted";
import type { ReservationOutcome } from "../usage/guard";
import { finalizeCandidate } from "../pipeline";
import { ModelOutputSchema, toPublicCandidate } from "./modelOutput";
import { parseStrictJson } from "./strictJson";
import { EndpointNotAllowedError, UnsafeRawResponseError, type MenuModel, type ModelRequest } from "./vertexClient";

/*
 * Runs one analysis with bounded time and at most ONE retry.
 *
 * Retry policy (proposal — final values need approval together with cost limits, D-008):
 *  - Retried (once): transient upstream failures only — HTTP 500/502/503/504 and
 *    network errors — and only if enough of the request deadline remains.
 *  - NOT retried: 429 (quota; retrying adds load and cost), 400 (bad request),
 *    401/403 (auth), 404 (model not found), missing credentials, timeouts
 *    (a timed-out call may still be billed and doubles waiting time), safety
 *    blocks / non-STOP finish reasons, and any invalid model output (a second
 *    inference costs as much as the first and is not more trustworthy).
 *
 * The caller never sees error messages from the SDK: they are reduced to a
 * public error code plus an internal enum `failure` used only for logging.
 */

export type GeminiOutcome =
  | {
      ok: true;
      body: AnalyzeMenuResponse;
      attempts: number;
      reserved: number;
      reservationsUnknown: number;
      reservationsRolledOver: number;
      finishReason?: string;
      limitReason?: string;
    }
  | {
      ok: false;
      code: Exclude<ErrorCode, "INVALID_INPUT">;
      failure: string;
      /** Model calls actually started. */
      attempts: number;
      /**
       * CONFIRMED reservations: the store answered "allowed" (in time or late), so
       * one unit of the daily cap is certainly consumed for each. Always ≥ attempts.
       */
      reserved: number;
      /**
       * Reservations whose outcome is UNKNOWN (no answer in time, a store error or
       * an invalid answer): the store may or may not have consumed a unit.
       * `reserved` is a lower bound of the units consumed; `reserved +
       * reservationsUnknown` is an upper bound only for a store that adds at most
       * one unit per consume() call (see LogEvent.reservationsUnknown, D-017).
       */
      reservationsUnknown: number;
      /**
       * Confirmed reservations that were NOT used because their JST day ended
       * before the model call could start (PROD-1). They stay counted in
       * `reserved` (conservative over-count); a new reservation was required.
       */
      reservationsRolledOver: number;
      upstreamStatus?: number;
      finishReason?: string;
      /** Why a retry was not started (daily cap / store error), if that happened. */
      limitReason?: string;
    };

/**
 * REQUIRED. Called before EVERY model call (the retry included) to reserve one
 * unit of the daily inference cap, bounded by `deadlineAt`. Anything but
 * "allowed" means: do not call the model. "allowed_late" = the unit WAS
 * consumed but the answer came after the deadline (counted, no model call).
 * A confirmed unit carries `validUntilMs`: the model call must START before it
 * (PROD-1). The outcome is validated at run time; anything else is a store error.
 */
export type ReserveAttempt = (deadlineAt: number) => Promise<ReservationOutcome>;

/** At most this many replacement reservations per attempt when a permit's day has ended. */
const MAX_ROLLOVERS_PER_ATTEMPT = 1;

/** Never start a model call with less time than this left before the deadline. */
export const MIN_MODEL_START_MS = 1_000;

type AttemptFailure = {
  code: Exclude<ErrorCode, "INVALID_INPUT">;
  failure: string;
  retryable: boolean;
  upstreamStatus?: number;
  finishReason?: string;
};

export const MAX_ATTEMPTS = 2; // the initial call + at most one retry
const RETRY_BACKOFF_MS = 500;
/** Do not start a retry with less than this much time left before the deadline. */
const MIN_RETRY_BUDGET_MS = 3_000;

export type RunnerDeps = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function analyzeWithGemini(
  model: MenuModel,
  config: GeminiConfig,
  input: ModelRequest,
  ctx: {
    requestId: string;
    /** Required: no model call without a reservation. */
    reserveAttempt: ReserveAttempt;
    /** Absolute deadline shared with the caller's store waits (defaults to now + requestDeadlineMs). */
    deadlineAt?: number;
  },
  deps: RunnerDeps = {},
): Promise<GeminiOutcome> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  /** Every clock read goes through the one validation boundary (MAJOR-2); invalid → ClockError. */
  const clock = () => readTime(now);
  const zero = { reserved: 0, reservationsUnknown: 0, reservationsRolledOver: 0 };
  const reserveAttempt = ctx.reserveAttempt;
  if (typeof reserveAttempt !== "function") {
    // Defense for untyped callers: never call the model without a reservation.
    return { ok: false, code: "AI_DISABLED", failure: "reservation_missing", attempts: 0, ...zero };
  }
  let deadline: number;
  try {
    deadline = ctx.deadlineAt ?? clock() + config.requestDeadlineMs;
  } catch {
    return { ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, ...zero };
  }
  if (!isValidTimeMs(deadline)) return { ok: false, code: "AI_DISABLED", failure: "clock_invalid", attempts: 0, ...zero };

  let last: AttemptFailure | undefined;
  let attemptsMade = 0;
  let reserved = 0;
  let reservationsUnknown = 0;
  let reservationsRolledOver = 0;
  let limitReason: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Every step below spends the same absolute deadline.
    let stop: string | undefined;
    let result: AttemptResult | undefined;
    try {
      if (attempt > 1) {
        if (!last?.retryable || deadline - clock() < MIN_RETRY_BUDGET_MS + RETRY_BACKOFF_MS) break;
        await sleep(RETRY_BACKOFF_MS);
      }
      let rollovers = 0;
      for (;;) {
        if (deadline - clock() < MIN_MODEL_START_MS) {
          stop = "deadline_exceeded_before_call";
          break;
        }
        const r = await reserveWithinDeadline(reserveAttempt, deadline, now);
        const outcome = r.outcome;
        if (outcome.decision === "limited") {
          stop = "daily_limit_reached";
          break;
        }
        if (outcome.decision === "store_error" || outcome.decision === "store_timeout") {
          // No usable answer: the store may still have consumed a unit (never under-counted).
          if (r.hookCalled) reservationsUnknown++;
          stop = r.clockInvalid ? "clock_invalid" : outcome.decision === "store_timeout" ? "usage_store_timeout" : "usage_store_error";
          break;
        }
        if (!("validUntilMs" in outcome)) {
          // Unreachable after validateReservation; fail closed if it ever happens.
          if (r.hookCalled) reservationsUnknown++;
          stop = "usage_store_error";
          break;
        }
        reserved++; // confirmed: the unit is consumed whatever happens next
        // Re-check after the (possibly slow) reservation. All preparation (deadline,
        // timeout) uses this read; the FINAL read happens in the start gate below.
        const t = clock();
        // MAJOR-A: the clock must not have gone back since the reservation STARTED
        // (a rewind while waiting could move a new-day permit into the old day).
        if (t < r.startedAt) {
          stop = "clock_invalid";
          break;
        }
        if (outcome.decision === "allowed_late" || t > deadline) {
          stop = "usage_reservation_late";
          break;
        }
        if (deadline - t < MIN_MODEL_START_MS) {
          stop = "deadline_exceeded_before_call";
          break;
        }
        if (t < outcome.validFromMs) {
          // A permit for a LATER day is never used for a start on an earlier day.
          stop = "reservation_not_yet_valid";
          break;
        }
        if (t < outcome.validUntilMs) {
          const timeoutMs = Math.min(config.attemptTimeoutMs, deadline - t);
          const window = { prepared: t, validUntilMs: outcome.validUntilMs, deadline };
          // MAJOR-1: the permit is re-checked at the LAST clock read, inside runAttempt,
          // immediately before model.generate(). If it fails, nothing is started.
          const run = await runAttempt(model, input, timeoutMs, ctx.requestId, () => startGate(now, window));
          if (run.started) {
            attemptsMade = attempt;
            result = run.result;
            break;
          }
          if (run.refusal === "clock_invalid") {
            stop = "clock_invalid";
            break;
          }
          if (run.refusal === "deadline") {
            stop = "deadline_exceeded_before_call";
            break;
          }
          // run.refusal === "expired": falls through to the rollover below.
        }
        // PROD-1: the unit was charged to a JST day that has ended. It is NOT a permit
        // for a call starting on the new day: reserve again on the new day (same
        // limits, same deadline). The old unit stays counted (conservative over-count).
        reservationsRolledOver++;
        if (rollovers >= MAX_ROLLOVERS_PER_ATTEMPT) {
          stop = "reservation_expired";
          break;
        }
        rollovers++;
      }
    } catch (e) {
      if (!(e instanceof ClockError)) throw e;
      stop = "clock_invalid"; // an invalid clock value never lets a model call start
    }
    if (stop) {
      const counts = { reserved, reservationsUnknown, reservationsRolledOver };
      if (attempt === 1) return { ok: false, code: "AI_DISABLED", failure: stop, attempts: 0, ...counts };
      limitReason = `retry_${stop}`; // keep the first attempt's error; no retry
      break;
    }
    if (!result) break;
    if (result.ok) {
      return { ok: true, body: result.body, attempts: attempt, reserved, reservationsUnknown, reservationsRolledOver, finishReason: result.finishReason };
    }
    last = result.failure;
  }
  const { retryable: _retryable, ...failure } = last ?? { code: "AI_FAILED" as const, failure: "unknown", retryable: false };
  void _retryable;
  return { ok: false, ...failure, attempts: attemptsMade, reserved, reservationsUnknown, reservationsRolledOver, ...(limitReason ? { limitReason } : {}) };
}

const PERMIT_DECISIONS: ReadonlySet<string> = new Set(["allowed", "allowed_late"]);
const NO_PERMIT_DECISIONS: ReadonlySet<string> = new Set(["limited", "store_error", "store_timeout"]);
const STORE_ERROR: ReservationOutcome = { decision: "store_error" };

/**
 * Run-time validation of a reservation outcome (fail closed). NEVER throws, for
 * any input (exported for its own contract test). Accepted shapes are
 * exactly `{ decision: "allowed" | "allowed_late", validFromMs, validUntilMs }`
 * (valid times, validFromMs < validUntilMs) and
 * `{ decision: "limited" | "store_error" | "store_timeout" }`,
 * as own data properties. Anything else (a legacy bare string, a missing or
 * non-integer validity, extra fields, getters) is a store error.
 */
export function validateReservation(v: unknown): ReservationOutcome {
  try {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return STORE_ERROR;
    // MAJOR-3: a Proxy can lie through its traps (descriptors, keys) or throw from
    // them; it is refused outright. Detection uses V8's internal check (Node.js).
    if (types.isProxy(v)) return STORE_ERROR;
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return STORE_ERROR; // plain or null-prototype only
    const keys = Reflect.ownKeys(v);
    const dd = Object.getOwnPropertyDescriptor(v, "decision");
    if (!dd || !("value" in dd) || typeof dd.value !== "string") return STORE_ERROR;
    const decision: string = dd.value;
    if (NO_PERMIT_DECISIONS.has(decision)) {
      return keys.length === 1 ? { decision: decision as "limited" | "store_error" | "store_timeout" } : STORE_ERROR;
    }
    if (!PERMIT_DECISIONS.has(decision) || keys.length !== 3) return STORE_ERROR;
    const fd = Object.getOwnPropertyDescriptor(v, "validFromMs");
    const vd = Object.getOwnPropertyDescriptor(v, "validUntilMs");
    if (!fd || !("value" in fd) || !isValidTimeMs(fd.value)) return STORE_ERROR;
    if (!vd || !("value" in vd) || !isValidTimeMs(vd.value) || vd.value <= 0) return STORE_ERROR;
    if (fd.value >= vd.value) return STORE_ERROR; // an empty or inverted validity range
    // A fresh object of our own: the untrusted value never travels further.
    return { decision: decision as "allowed" | "allowed_late", validFromMs: fd.value, validUntilMs: vd.value };
  } catch {
    // Any reflection error (a revoked or throwing object) is a store error, never a rejection.
    return STORE_ERROR;
  }
}

/** Why the start gate refused to start a model call. */
type Refusal = "expired" | "deadline" | "clock_invalid";

type StartWindow = {
  /** Clock value used for the preparation (deadline / timeout) of this attempt. */
  prepared: number;
  validUntilMs: number;
  deadline: number;
};

/**
 * The FINAL clock read before model.generate() (MAJOR-1, MAJOR-A).
 *
 * Precondition (checked by the caller with the `prepared` read, see the loop):
 *   reservationStartedAt ≤ prepared, and validFromMs ≤ prepared < validUntilMs.
 * The gate therefore only needs: the clock is valid and has not gone back since
 * `prepared` (which implies it has not gone back since the reservation started
 * and is still ≥ validFromMs), the permit has not ended (exclusive), and the
 * deadline has not passed.
 */
function startGate(now: () => number, w: StartWindow): "ok" | Refusal {
  const t = tryReadTime(now);
  if (t === undefined || t < w.prepared) return "clock_invalid";
  if (t >= w.validUntilMs) return "expired";
  if (t > w.deadline) return "deadline";
  return "ok";
}

/**
 * Calls the reservation hook and waits for it at most until the deadline.
 *  - The hook is not called at all once the deadline has passed.
 *  - The wait timer is armed from the time left AFTER the hook's synchronous
 *    part returned (a hook that blocks first cannot extend the deadline); if
 *    nothing is left, the result is an immediate timeout unless the answer has
 *    already settled.
 *  - A synchronous throw, a rejected promise or an unexpected value is a store
 *    error (fail closed) — never an exception that escapes the runner.
 *  - Losing the race does not cancel the store operation (it may still consume a
 *    unit): the result is only "no answer in time", and no model call follows.
 *  - `hookCalled` tells the caller whether a unit may have been consumed.
 */
async function reserveWithinDeadline(
  hook: ReserveAttempt,
  deadline: number,
  now: () => number,
): Promise<{ outcome: ReservationOutcome; hookCalled: boolean; startedAt: number; clockInvalid?: true }> {
  const before = tryReadTime(now);
  if (before === undefined) return { outcome: STORE_ERROR, hookCalled: false, startedAt: 0, clockInvalid: true };
  if (deadline - before <= 0) return { outcome: { decision: "store_timeout" }, hookCalled: false, startedAt: before };
  let raw: unknown;
  try {
    raw = hook(deadline);
  } catch {
    return { outcome: STORE_ERROR, hookCalled: true, startedAt: before };
  }
  // MAJOR-B: validated in the FIRST fulfillment handler and turned into our own object;
  // the untrusted value never reaches a derived promise, and `settled` never rejects.
  const settled = settleUntrusted(raw, validateReservation, STORE_ERROR);
  // Measured AFTER the hook's synchronous part. Nothing left → a 0 ms timer: no
  // extra waiting, but an answer that has ALREADY settled is still observed (so a
  // confirmed unit is reported as confirmed, not as unknown).
  const after = tryReadTime(now);
  if (after === undefined) return { outcome: STORE_ERROR, hookCalled: true, startedAt: before, clockInvalid: true };
  const remaining = Math.max(0, deadline - after);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // MINOR-1: a private symbol, so no value a hook can return is mistaken for the timeout.
  const timeout = new Promise<typeof HOOK_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(HOOK_TIMEOUT), remaining);
  });
  try {
    const d = await Promise.race([settled, timeout]);
    return { outcome: d === HOOK_TIMEOUT ? { decision: "store_timeout" } : d, hookCalled: true, startedAt: before };
  } finally {
    clearTimeout(timer);
  }
}

const HOOK_TIMEOUT: unique symbol = Symbol("reservation hook timeout");

type AttemptResult =
  | { ok: true; body: AnalyzeMenuResponse; finishReason?: string }
  | { ok: false; failure: AttemptFailure };

/**
 * Runs one model attempt. All preparation (abort controller, timeout timer) is
 * done FIRST; then `gate()` performs the final clock read and, only if it says
 * "ok", model.generate() is called synchronously right after it (no clock read
 * and no await in between). A refused gate starts nothing.
 */
async function runAttempt(
  model: MenuModel,
  input: ModelRequest,
  timeoutMs: number,
  requestId: string,
  gate: () => "ok" | Refusal,
): Promise<{ started: true; result: AttemptResult } | { started: false; refusal: Refusal }> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new TimeoutSignal());
    }, timeoutMs);
  });
  timeout.catch(() => undefined); // never unhandled, also when the gate refuses

  const decision = gate();
  if (decision !== "ok") {
    clearTimeout(timer);
    return { started: false, refusal: decision };
  }
  return { started: true, result: await callModel(model, input, timeoutMs, requestId, controller, timeout, () => timedOut, () => clearTimeout(timer)) };
}

async function callModel(
  model: MenuModel,
  input: ModelRequest,
  timeoutMs: number,
  requestId: string,
  controller: AbortController,
  timeout: Promise<never>,
  timedOut: () => boolean,
  clearTimer: () => void,
): Promise<AttemptResult> {
  let call;
  try {
    // Race guards against an SDK call that ignores the abort signal.
    call = await Promise.race([model.generate(input, { signal: controller.signal, timeoutMs }), timeout]);
  } catch (e) {
    return { ok: false, failure: classifyError(e, timedOut()) };
  } finally {
    clearTimer();
  }

  if (call.blockReason) return fail("AI_FAILED", "blocked", { finishReason: call.blockReason });
  if (call.finishReason !== undefined && call.finishReason !== "STOP") {
    return fail("AI_FAILED", "finish_not_stop", { finishReason: call.finishReason });
  }
  // A response whose shape is not exactly "one candidate with text parts" is never used, even in part.
  if (call.outputIssue) return fail("AI_FAILED", call.outputIssue);
  if (!call.text) return fail("AI_FAILED", "empty_output");

  // The ONLY parse of the model text: strict (duplicate keys at any level are
  // rejected after escape decoding, bounded size/depth). JSON.parse is not used:
  // it silently keeps the last duplicate key and can drop allergen information.
  const parsed = parseStrictJson(call.text);
  if (!parsed.ok) {
    if (parsed.issue === "duplicate_key") return fail("AI_FAILED", "model_duplicate_key");
    if (parsed.issue === "too_large") return fail("AI_FAILED", "model_json_too_large");
    if (parsed.issue === "too_deep") return fail("AI_FAILED", "model_json_too_deep");
    return fail("AI_FAILED", "model_invalid_json");
  }
  const modelOut = ModelOutputSchema.safeParse(parsed.value);
  if (!modelOut.success) return fail("AI_FAILED", "model_schema");

  const converted = toPublicCandidate(modelOut.data, { requestId, userLang: input.userLang });
  if (!converted.ok) return fail("AI_FAILED", converted.failure);

  const finalized = finalizeCandidate(converted.candidate, input.allergens, { requestId, dataOrigin: "ai_analysis" });
  if (!finalized.ok) return fail("AI_FAILED", finalized.failure);
  // EV-052 safety net: conversion already drops every AI rationale. If one ever
  // reaches the final body (a future change re-injects it), fail closed instead of
  // publishing it or silently editing the validated body.
  if (hasPublishedAiRationale(finalized.body)) return fail("AI_FAILED", "ai_rationale_not_redacted");
  return { ok: true, body: finalized.body, finishReason: call.finishReason };
}

function fail(
  code: AttemptFailure["code"],
  failure: string,
  extra: Partial<Pick<AttemptFailure, "finishReason" | "upstreamStatus">> = {},
): AttemptResult {
  return { ok: false, failure: { code, failure, retryable: false, ...extra } };
}

class TimeoutSignal extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutSignal";
  }
}

/** Maps an SDK / network error to a public code. Never exposes the message. */
export function classifyError(e: unknown, timedOut: boolean): AttemptFailure {
  if (e instanceof EndpointNotAllowedError) {
    return { code: "AI_DISABLED", failure: "endpoint_not_allowed", retryable: false };
  }
  if (e instanceof UnsafeRawResponseError) {
    // A successful but unacceptable raw body: never retried (a second inference costs as much).
    if (e.reason === "raw_response_too_large") return { code: "AI_FAILED", failure: "raw_response_too_large", retryable: false };
    return { code: "AI_FAILED", failure: "raw_response_rejected", retryable: false };
  }
  if (timedOut || e instanceof TimeoutSignal || isAbortError(e)) {
    return { code: "AI_TIMEOUT", failure: "timeout", retryable: false };
  }
  const status = httpStatusOf(e);
  if (status !== undefined) {
    if (status === 429) return { code: "RATE_LIMITED", failure: "upstream_rate_limited", retryable: false, upstreamStatus: status };
    if (status === 401 || status === 403) return { code: "AI_DISABLED", failure: "upstream_auth", retryable: false, upstreamStatus: status };
    if (status === 404) return { code: "AI_DISABLED", failure: "upstream_not_found", retryable: false, upstreamStatus: status };
    if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
      return { code: "AI_FAILED", failure: "upstream_transient", retryable: true, upstreamStatus: status };
    }
    return { code: "AI_FAILED", failure: "upstream_error", retryable: false, upstreamStatus: status };
  }
  const message = e instanceof Error ? e.message : "";
  if (/default credentials|could not load the default credentials|unable to detect a project id/i.test(message)) {
    return { code: "AI_DISABLED", failure: "credentials_unavailable", retryable: false };
  }
  if (isNetworkError(e)) return { code: "AI_FAILED", failure: "network", retryable: true };
  return { code: "AI_FAILED", failure: "unknown", retryable: false };
}

function httpStatusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e) {
    const s = (e as { status: unknown }).status;
    if (typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599) return s;
  }
  return undefined;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code ?? (e.cause as { code?: unknown } | undefined)?.code;
  return (
    (e.name === "TypeError" && /fetch failed/i.test(e.message)) ||
    (typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"].includes(code))
  );
}

/** True when any ai_inferred assessment in a final AI response still carries a rationale (EV-052). */
export function hasPublishedAiRationale(body: AnalyzeMenuResponse): boolean {
  return body.items.some((i) => i.allergens.some((a) => a.category === "ai_inferred" && a.rationale !== null));
}
