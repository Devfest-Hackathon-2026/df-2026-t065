import { BlockedReason, FinishReason, GoogleGenAI, ThinkingLevel, type GoogleGenAIOptions } from "@google/genai";
import type { AllergenCode } from "@/contracts/allergens";
import type { LanguageTag } from "@/contracts/analyze";
import type { GeminiConfig } from "../config";
import type { ImageType } from "../requestBody";
import { MODEL_RESPONSE_JSON_SCHEMA } from "./modelOutput";
import { SYSTEM_INSTRUCTION, buildUserPrompt } from "./prompt";
import { parseStrictJson } from "./strictJson";

/*
 * The ONLY module that talks to Gemini. Everything else depends on the
 * MenuModel interface, so tests replace it with a test double and no test ever
 * calls a real API.
 *
 * SDK: Google Gen AI SDK (`@google/genai`), Google's current SDK for Gemini;
 * its README states that `@google-cloud/vertexai` is a previous iteration that
 * no longer receives new Gemini features. Vertex AI is selected with
 * `enterprise: true` (the SDK's recommended flag; `vertexai` is the legacy
 * alias) plus an explicit project and location, which also makes the SDK
 * ignore any API key found in environment variables. Credentials come from
 * Application Default Credentials (the Cloud Run service account).
 *
 * Cost-related SDK behaviour pinned explicitly:
 *  - no `retryOptions`  → the SDK performs no retries (our runner allows at most one).
 *  - `automaticContinuation: false` → no extra follow-up model calls.
 *  - `candidateCount: 1`, bounded `maxOutputTokens`.
 *  - `temperature: 1.0`, sent explicitly (D-032). Vertex AI "Get started with Gemini 3"
 *    (checked 2026-11-09) strongly recommends keeping the Gemini 3 default 1.0 and
 *    removing low values set for determinism: below 1.0 "may lead to unexpected
 *    behavior, such as looping or degraded performance". A loop would end as
 *    MAX_TOKENS (AI_FAILED, a reservation consumed) or a timeout. Determinism is not
 *    a safety control here: every model output is still schema-checked, post-processed
 *    and shown as unconfirmed / staff-confirmation-required.
 *  - `thinkingConfig.thinkingLevel: MEDIUM`, sent explicitly. For gemini-3.5-flash
 *    the official default is already MEDIUM (Vertex AI "Thinking" page, checked
 *    2026-11-09), so this does not change behaviour: it only keeps a silent server
 *    default change from altering latency and thinking-token cost. Thoughts are not
 *    requested (`includeThoughts: false`). `thinkingBudget` is NOT sent: it is
 *    deprecated for Gemini 3+ and combining it with thinkingLevel is a 400.
 */

export type ModelRequest = {
  image: Uint8Array;
  mimeType: ImageType;
  userLang: LanguageTag;
  storeLang: LanguageTag;
  allergens: readonly AllergenCode[];
};

export type ModelCallResult = {
  /** Raw text of the single candidate (expected to be JSON). Never logged. */
  text: string | undefined;
  /** Set when the response shape is not acceptable; the text is then undefined. */
  outputIssue?: "malformed_response" | "unexpected_part";
  finishReason?: string;
  blockReason?: string;
};

export interface MenuModel {
  generate(req: ModelRequest, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ModelCallResult>;
}

type ClientFactory = (o: GoogleGenAIOptions) => Pick<GoogleGenAI, "models">;

/** Thrown when the SDK tries to contact a host other than the expected Vertex AI endpoint. */
export class EndpointNotAllowedError extends Error {
  constructor() {
    super("endpoint not allowed");
    this.name = "EndpointNotAllowedError";
  }
}

/**
 * Thrown when a successful generateContent HTTP body is not acceptable BEFORE
 * the SDK converts it (explicit top-level null, duplicate keys, invalid JSON,
 * too large). Mapped to AI_FAILED, never retried. Carries no response text.
 */
export class UnsafeRawResponseError extends Error {
  constructor(readonly reason: "raw_response_rejected" | "raw_response_too_large") {
    super("raw response rejected");
    this.name = "UnsafeRawResponseError";
  }
}

/**
 * Upper bound on a raw generateContent body: the model text (≤ 512 KiB UTF-8)
 * JSON-escaped inside the envelope can grow up to 6× in the worst case
 * (\uXXXX), plus metadata. Larger bodies are refused while streaming.
 */
export const MAX_RAW_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The only hosts this app may send the ADC token to: the regional endpoint for
 * the configured location, or the global endpoint for location "global".
 */
export function allowedVertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/**
 * fetch wrapper given to the SDK (defense in depth for mn-1). Every SDK request
 * passes through it, so even if an endpoint override appears after start-up,
 * no request (and no token) can leave for another host or over plain HTTP.
 */
export function createGuardedFetch(location: string, baseFetch: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  const host = allowedVertexHost(location);
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EndpointNotAllowedError();
    }
    if (url.protocol !== "https:" || url.hostname !== host || url.port !== "" || url.username !== "" || url.password !== "") {
      throw new EndpointNotAllowedError();
    }
    // Never follow redirects (m-1): a redirect from the allowed host must not carry the
    // ADC token anywhere else. `redirect: "error"` overrides whatever the caller asked for.
    let res: Response;
    try {
      res = await baseFetch(input, { ...init, redirect: "error" });
    } catch (e) {
      // Node's fetch reports a refused redirect as TypeError("fetch failed", { cause: "unexpected redirect" }).
      // Classify it as a blocked endpoint (AI_DISABLED, not retried), not as a transient network error.
      if (isRedirectError(e)) throw new EndpointNotAllowedError();
      throw e;
    }
    // Defense in depth for fetch implementations that hand back a redirect response.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw new EndpointNotAllowedError();
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (res.ok && method === "POST" && url.pathname.endsWith(":generateContent")) {
      return inspectRawGenerateContent(res);
    }
    // Error statuses are left to the SDK (ApiError with a status; its message is never logged).
    return res;
  };
}

/**
 * Raw body check for a SUCCESSFUL generateContent response, before the SDK sees
 * it. @google/genai 2.30.0 parses the body with JSON.parse (last duplicate key
 * wins) and then drops every top-level field whose value is null/undefined
 * (`generateContentResponseFromVertex`), so `"promptFeedback": null` would be
 * indistinguishable from an omitted field afterwards. Here:
 *  - the body is read with a byte bound (streaming; aborts with the request's
 *    signal like any body read) and must be valid UTF-8;
 *  - it is parsed by the same strict parser as the model text (duplicate keys
 *    at any level, a second document, too deep / too many values → rejected);
 *  - it must be a JSON object, and NO top-level field may be an explicit null;
 *  - the accepted text is handed to the SDK as a new Response with the same
 *    status and headers (minus encoding/length, the body is already decoded),
 *    so the SDK's own parsing and every later check still run unchanged.
 * Nothing from the body is logged or put into the error.
 */
async function inspectRawGenerateContent(res: Response): Promise<Response> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RAW_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new UnsafeRawResponseError("raw_response_too_large");
  }
  const bytes = await readBounded(res, MAX_RAW_RESPONSE_BYTES);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UnsafeRawResponseError("raw_response_rejected");
  }
  const parsed = parseStrictJson(text, { maxBytes: MAX_RAW_RESPONSE_BYTES });
  if (!parsed.ok) throw new UnsafeRawResponseError(parsed.issue === "too_large" ? "raw_response_too_large" : "raw_response_rejected");
  const top = parsed.value;
  if (typeof top !== "object" || top === null || Array.isArray(top)) throw new UnsafeRawResponseError("raw_response_rejected");
  for (const key of Object.keys(top)) {
    // The SDK would silently drop it: an explicit null is never "absent".
    if ((top as Record<string, unknown>)[key] === null) throw new UnsafeRawResponseError("raw_response_rejected");
  }
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new UnsafeRawResponseError("raw_response_too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function isRedirectError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = e.cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /redirect/i.test(causeMessage) || /redirect/i.test(e.message);
}

// ---------------------------------------------------------------------------
// Response text extraction (no SDK getters, no console output)
// ---------------------------------------------------------------------------

export type ExtractResult = { ok: true; text: string } | { ok: false; issue: "no_text" | "malformed_response" | "unexpected_part" };

const ALLOWED_PART_KEYS: ReadonlySet<string> = new Set(["text", "thought", "thoughtSignature"]);

class Malformed extends Error {}

/** Reads an OWN DATA property only; an accessor (getter) is treated as malformed and never invoked. */
function dataProp(obj: unknown, key: string): { present: boolean; value: unknown } {
  if (typeof obj !== "object" || obj === null) return { present: false, value: undefined };
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return { present: false, value: undefined };
  if (!("value" in d)) throw new Malformed();
  return { present: true, value: d.value };
}

/**
 * Reads element `i` of an array as an OWN DATA property. A hole or an accessor
 * (getter/setter defined on an index) is malformed; no getter is ever invoked.
 */
function dataElement(arr: readonly unknown[], i: number): unknown {
  const d = Object.getOwnPropertyDescriptor(arr, i);
  if (!d || !("value" in d)) throw new Malformed();
  return d.value;
}

/**
 * Text extraction specification (the response must be exactly what we asked for):
 *  - `candidates` absent or empty → "no_text"; not an array or more than one
 *    candidate (we request candidateCount 1) → "malformed_response".
 *  - `content` / `parts` absent or `parts` empty → "no_text"; wrong types → "malformed_response".
 *  - EVERY level (response, candidates[0], content, parts[i], part fields) is
 *    read through own data-property descriptors only. An accessor anywhere, or
 *    an array hole → "malformed_response". No getter or setter is ever invoked.
 *  - every part must be a plain object whose OWN keys (enumerable or not, symbols
 *    included) are only text / thought / thoughtSignature. ANY other key
 *    (inlineData, functionCall, an unknown field…) → "unexpected_part" for the
 *    WHOLE response: nothing is silently dropped and no partial text is used.
 *  - every part is validated in full, thought parts included: `thought` must be
 *    a boolean, `thoughtSignature` a string, and `text` a string (optional only
 *    on a thought part). Only then are `thought: true` parts skipped.
 *  - The non-thought texts are joined in order (structured JSON may be split
 *    across parts); the JSON is then parsed strictly and validated by the caller.
 *  - only thought parts → "no_text".
 */
export function extractResponseText(res: unknown): ExtractResult {
  try {
    const candidates = dataProp(res, "candidates");
    if (!candidates.present || candidates.value === undefined || candidates.value === null) return { ok: false, issue: "no_text" };
    if (!Array.isArray(candidates.value)) return { ok: false, issue: "malformed_response" };
    if (candidates.value.length === 0) return { ok: false, issue: "no_text" };
    if (candidates.value.length !== 1) return { ok: false, issue: "malformed_response" };
    const candidate: unknown = dataElement(candidates.value, 0);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return { ok: false, issue: "malformed_response" };

    const content = dataProp(candidate, "content");
    if (!content.present || content.value === undefined || content.value === null) return { ok: false, issue: "no_text" };
    if (typeof content.value !== "object" || Array.isArray(content.value)) return { ok: false, issue: "malformed_response" };

    const parts = dataProp(content.value, "parts");
    if (!parts.present || parts.value === undefined || parts.value === null) return { ok: false, issue: "no_text" };
    if (!Array.isArray(parts.value)) return { ok: false, issue: "malformed_response" };
    const partList = parts.value as unknown[];
    if (partList.length === 0) return { ok: false, issue: "no_text" };

    const texts: string[] = [];
    for (let i = 0; i < partList.length; i++) {
      const part = dataElement(partList, i);
      if (typeof part !== "object" || part === null || Array.isArray(part)) return { ok: false, issue: "malformed_response" };
      for (const key of Reflect.ownKeys(part)) {
        if (typeof key !== "string" || !ALLOWED_PART_KEYS.has(key)) return { ok: false, issue: "unexpected_part" };
      }
      const thought = dataProp(part, "thought");
      if (thought.present && thought.value !== undefined && typeof thought.value !== "boolean") return { ok: false, issue: "malformed_response" };
      const sig = dataProp(part, "thoughtSignature");
      if (sig.present && sig.value !== undefined && typeof sig.value !== "string") return { ok: false, issue: "malformed_response" };
      const t = dataProp(part, "text");
      if (thought.value === true) {
        // Reasoning: validated like any other part, then skipped.
        if (t.present && t.value !== undefined && typeof t.value !== "string") return { ok: false, issue: "malformed_response" };
        continue;
      }
      if (typeof t.value !== "string") return { ok: false, issue: "malformed_response" };
      texts.push(t.value);
    }
    return texts.length > 0 ? { ok: true, text: texts.join("") } : { ok: false, issue: "no_text" };
  } catch {
    return { ok: false, issue: "malformed_response" };
  }
}

const KNOWN_FINISH_REASONS: ReadonlySet<string> = new Set(Object.values(FinishReason));
const KNOWN_BLOCK_REASONS: ReadonlySet<string> = new Set(Object.values(BlockedReason));

function allowListed(v: unknown, known: ReadonlySet<string>): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" && known.has(v) ? v : "unknown";
}

const PROMPT_FEEDBACK_KEYS: ReadonlySet<string> = new Set(["blockReason", "blockReasonMessage", "safetyRatings"]);
/** SafetyRating fields of @google/genai 2.30.0 and their JSON types. */
const SAFETY_RATING_TYPES: Readonly<Record<string, "string" | "number" | "boolean">> = {
  category: "string",
  probability: "string",
  probabilityScore: "number",
  severity: "string",
  severityScore: "number",
  overwrittenThreshold: "string",
  blocked: "boolean",
};

function isPlainRecord(v: unknown): v is object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every own key (enumerable or not, symbols included) must be in `allowed`. */
function onlyKeys(obj: object, allowed: ReadonlySet<string> | Readonly<Record<string, unknown>>): void {
  for (const key of Reflect.ownKeys(obj)) {
    const known = typeof key === "string" && (allowed instanceof Set ? allowed.has(key) : Object.hasOwn(allowed, key));
    if (!known) throw new Malformed();
  }
}

/**
 * Strict validation of `promptFeedback` (CONDITIONAL GO, required fix B).
 *  - Absent / undefined → no feedback (normal response).
 *  - Present → must be a plain object whose own keys are only blockReason /
 *    blockReasonMessage / safetyRatings, each with the SDK's type. Anything else
 *    (a string such as "SAFETY", null, an array, an unknown field, a getter) is
 *    malformed: it is never read as "no feedback".
 *  - blockReason: absent, or a string (an unknown string is still a block,
 *    logged only as "unknown"). blockReasonMessage: a string, never logged.
 *  - safetyRatings: an array of plain objects with known fields and types. A
 *    rating with `blocked: true` but no blockReason is an inconsistent block
 *    signal → malformed (fail safe).
 * Returns the raw block reason (validated as a string) or undefined; throws Malformed.
 */
function validatePromptFeedback(res: unknown): string | undefined {
  const fb = dataProp(res, "promptFeedback");
  if (!fb.present || fb.value === undefined) return undefined;
  const feedback = fb.value;
  if (!isPlainRecord(feedback)) throw new Malformed();
  onlyKeys(feedback, PROMPT_FEEDBACK_KEYS);

  const reason = dataProp(feedback, "blockReason");
  if (reason.present && reason.value !== undefined && typeof reason.value !== "string") throw new Malformed();
  const blockReason = reason.value as string | undefined;

  const message = dataProp(feedback, "blockReasonMessage");
  if (message.present && message.value !== undefined && typeof message.value !== "string") throw new Malformed();

  const ratings = dataProp(feedback, "safetyRatings");
  if (ratings.present && ratings.value !== undefined) {
    if (!Array.isArray(ratings.value)) throw new Malformed();
    const list = ratings.value as unknown[];
    for (let i = 0; i < list.length; i++) {
      const rating = dataElement(list, i);
      if (!isPlainRecord(rating)) throw new Malformed();
      onlyKeys(rating, SAFETY_RATING_TYPES);
      for (const [key, type] of Object.entries(SAFETY_RATING_TYPES)) {
        const v = dataProp(rating, key);
        if (!v.present || v.value === undefined) continue;
        if (typeof v.value !== type || (type === "number" && !Number.isFinite(v.value))) throw new Malformed();
      }
      if (dataProp(rating, "blocked").value === true && blockReason === undefined) throw new Malformed();
    }
  }
  return blockReason;
}

/**
 * Reads finishReason / blockReason through data descriptors only. An accessor
 * at any level on the way (candidates, candidates[0], finishReason,
 * promptFeedback, blockReason) is NOT treated as "absent" — that would let a
 * hidden SAFETY / non-STOP value bypass the safety checks — but as malformed.
 */
function readSafetyMetadata(res: unknown): { ok: true; finishReason?: string; blockReason?: string } | { ok: false } {
  try {
    let finishRaw: unknown;
    const candidates = dataProp(res, "candidates").value;
    if (Array.isArray(candidates) && candidates.length === 1) {
      const c: unknown = dataElement(candidates, 0);
      if (typeof c === "object" && c !== null) finishRaw = dataProp(c, "finishReason").value;
    }
    const blockRaw = validatePromptFeedback(res);
    // Upstream values are checked against the SDK's own enums at run time (m3):
    // anything unexpected becomes "unknown" and can never reach a log line verbatim.
    return { ok: true, finishReason: allowListed(finishRaw, KNOWN_FINISH_REASONS), blockReason: allowListed(blockRaw, KNOWN_BLOCK_REASONS) };
  } catch {
    return { ok: false };
  }
}

/** Turns a raw SDK response into the runner's input. Never invokes a getter. */
export function inspectModelResponse(res: unknown): ModelCallResult {
  const meta = readSafetyMetadata(res);
  if (!meta.ok) return { text: undefined, outputIssue: "malformed_response", finishReason: undefined, blockReason: undefined };
  const extracted = extractResponseText(res);
  return {
    text: extracted.ok ? extracted.text : undefined,
    ...(extracted.ok || extracted.issue === "no_text" ? {} : { outputIssue: extracted.issue }),
    finishReason: meta.finishReason,
    blockReason: meta.blockReason,
  };
}

const defaultFactory: ClientFactory = (o) => new GoogleGenAI(o);

export function createVertexMenuModel(cfg: GeminiConfig, factory: ClientFactory = defaultFactory): MenuModel {
  let client: Pick<GoogleGenAI, "models"> | undefined;
  return {
    async generate(req, { signal, timeoutMs }) {
      client ??= factory({
        enterprise: true,
        project: cfg.project,
        location: cfg.location,
        httpOptions: { fetch: createGuardedFetch(cfg.location) },
      });
      const res = await client.models.generateContent({
        model: cfg.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: buildUserPrompt(req) },
              { inlineData: { mimeType: req.mimeType, data: Buffer.from(req.image).toString("base64") } },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseJsonSchema: MODEL_RESPONSE_JSON_SCHEMA,
          temperature: 1.0,
          candidateCount: 1,
          maxOutputTokens: cfg.maxOutputTokens,
          automaticContinuation: false,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM, includeThoughts: false },
          abortSignal: signal,
          httpOptions: { timeout: timeoutMs },
        },
      });
      // The SDK's `res.text` getter is NOT used: it writes part field names (which can
      // contain model/attacker-influenced data) to console.warn. Only known data
      // properties are read directly, without invoking any getter.
      return inspectModelResponse(res);
    },
  };
}

/** One client per configuration, reused across requests (keeps the ADC token cache). */
const cache = new Map<string, MenuModel>();

export function getVertexMenuModel(cfg: GeminiConfig): MenuModel {
  const key = `${cfg.project}|${cfg.location}|${cfg.model}|${cfg.maxOutputTokens}`;
  let model = cache.get(key);
  if (!model) {
    model = createVertexMenuModel(cfg);
    cache.set(key, model);
  }
  return model;
}
