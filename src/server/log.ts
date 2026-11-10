/*
 * Structured logging with an allow-list of fields.
 *
 * AGENTS.md §1-13: logs must never contain images, menu text, AI output text,
 * or personal data (the user's allergen selection is health information).
 * The type below is the only shape that can be logged, so free text cannot be
 * passed in by accident. Error objects are reduced to a category.
 */

export type LogEvent = {
  event: "analyze_menu";
  requestId: string;
  outcome: "ok" | "error";
  /** Public error code returned to the client (if any). */
  errorCode?: string;
  /** INVALID_INPUT reason (enum value, never free text). */
  reason?: string;
  /** Internal failure category (enum value, never an error message). */
  failure?: string;
  /** HTTP status from the model API, if any. */
  upstreamStatus?: number;
  /** Model finish reason enum, if any. */
  finishReason?: string;
  /** Model calls actually started. */
  attempts?: number;
  /**
   * CONFIRMED reservations against the daily inference cap (the store answered
   * "allowed", in time or late): each one certainly consumed a unit (PR5).
   */
  reserved?: number;
  /**
   * Reservations with an UNKNOWN outcome (timeout / store error / invalid
   * answer): each may or may not have consumed a unit.
   * `reserved` is a LOWER bound of the units the request consumed. The upper
   * bound `reserved + reservationsUnknown` holds only for a store whose
   * consume() adds at most one unit per call (the in-memory store). A shared
   * store whose client may retry an already-committed write (e.g. a Firestore
   * transaction whose commit response was lost) can add more; that bound is
   * NOT guaranteed until such a store is designed and verified (D-017).
   */
  reservationsUnknown?: number;
  /**
   * Confirmed reservations not used because their JST day ended before the call
   * started (PROD-1). Already included in `reserved` (conservative over-count).
   */
  reservationsRolledOver?: number;
  /** Why a guard limited the request or a retry (enum value, PR5). */
  limitReason?: string;
  latencyMs?: number;
  mock?: boolean;
};

export type Logger = (e: LogEvent) => void;

/*
 * Value allow-lists (m3). Every string value is checked against a FIXED list;
 * anything else is written as "unknown". A free-text or attacker-influenced value
 * (an SDK enum we do not know, an error message, a header) can therefore never be
 * logged verbatim, even if it looks like an identifier.
 */
export const LOG_ERROR_CODES = ["INVALID_INPUT", "RATE_LIMITED", "AI_DISABLED", "AI_TIMEOUT", "AI_FAILED"] as const;
export const LOG_REASONS = [
  "malformed_request",
  "image_missing",
  "image_too_large",
  "unsupported_image_type",
  "unsupported_language_pair",
  "invalid_allergens",
] as const;
const STOP_REASONS = [
  "daily_limit_reached",
  "usage_store_error",
  "usage_store_timeout",
  "usage_reservation_late",
  "reservation_expired",
  "reservation_not_yet_valid",
  "clock_invalid",
  "deadline_exceeded_before_call",
] as const;
export const LOG_FAILURES = [
  // configuration / guards
  "kill_switch_off",
  "not_configured",
  "endpoint_override_blocked",
  "usage_config_invalid",
  "usage_store_unavailable",
  "rate_limited",
  "rate_check_late",
  "reservation_missing",
  ...STOP_REASONS,
  // model call
  "endpoint_not_allowed",
  "timeout",
  "upstream_rate_limited",
  "upstream_auth",
  "upstream_not_found",
  "upstream_transient",
  "upstream_error",
  "credentials_unavailable",
  "network",
  "unknown",
  // model output
  "blocked",
  "finish_not_stop",
  "empty_output",
  "raw_response_rejected",
  "raw_response_too_large",
  "malformed_response",
  "unexpected_part",
  "model_invalid_json",
  "model_duplicate_key",
  "model_json_too_large",
  "model_json_too_deep",
  "model_schema",
  "model_inconsistent_assessment",
  "public_schema",
  "invariants",
  "public_schema_final",
  "invariants_final",
  "ai_rationale_not_redacted",
  // mock
  "mock_error",
] as const;
export const LOG_LIMIT_REASONS = STOP_REASONS.map((r) => `retry_${r}`);
/** Finish/block reasons known to @google/genai 2.30.0 (checked by a test), plus "unknown". */
export const LOG_FINISH_REASONS = [
  "FINISH_REASON_UNSPECIFIED",
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "IMAGE_SAFETY",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "IMAGE_PROHIBITED_CONTENT",
  "NO_IMAGE",
  "IMAGE_RECITATION",
  "IMAGE_OTHER",
  "CONTINUATION",
  "BLOCKED_REASON_UNSPECIFIED",
  "MODEL_ARMOR",
  "JAILBREAK",
  "unknown",
] as const;

const VALUE_ALLOW_LISTS: Partial<Record<keyof LogEvent, ReadonlySet<string>>> = {
  event: new Set(["analyze_menu"]),
  outcome: new Set(["ok", "error"]),
  errorCode: new Set(LOG_ERROR_CODES),
  reason: new Set(LOG_REASONS),
  failure: new Set(LOG_FAILURES),
  limitReason: new Set(LOG_LIMIT_REASONS),
  finishReason: new Set(LOG_FINISH_REASONS),
};

const ALLOWED_KEYS = new Set<keyof LogEvent>([
  "event",
  "requestId",
  "outcome",
  "errorCode",
  "reason",
  "failure",
  "upstreamStatus",
  "finishReason",
  "attempts",
  "reserved",
  "reservationsUnknown",
  "reservationsRolledOver",
  "limitReason",
  "latencyMs",
  "mock",
]);

/** Keeps only allow-listed keys and only short enum-like string values. */
export function sanitizeLogEvent(e: LogEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!ALLOWED_KEYS.has(k as keyof LogEvent) || v === undefined) continue;
    if (typeof v === "string") {
      const allowed = VALUE_ALLOW_LISTS[k as keyof LogEvent];
      if (allowed) {
        out[k] = allowed.has(v) ? v : "unknown";
      } else if (k === "requestId" && /^[A-Za-z0-9_-]{1,64}$/.test(v)) {
        // request ids are generated by the server (UUID)
        out[k] = v;
      }
    } else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

export const consoleLogger: Logger = (e) => {
  console.log(JSON.stringify(sanitizeLogEvent(e)));
};
