import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";
import { EndpointNotAllowedError, allowedVertexHost, createGuardedFetch, createVertexMenuModel } from "@/server/gemini/vertexClient";
import { MODEL_RESPONSE_JSON_SCHEMA } from "@/server/gemini/modelOutput";

/*
 * SYNTHETIC TEST DATA — network-free compatibility checks for gemini-3.5-flash with the
 * real @google/genai 2.30.0 request/response path (no real Vertex AI call, no credentials).
 *  - The app's own guarded fetch is used; its base fetch (the global `fetch`) is stubbed,
 *    so the stub sees exactly the URL and JSON body the SDK would send.
 *  - Auth is a stub auth client (no ADC lookup).
 * Response bodies below are hand-written to the documented Gemini 3 shape
 * (text parts may carry thoughtSignature; thought parts are flagged) — they are not
 * recorded from the real service.
 */

const PROJECT = "example-allergybridge";
const MODEL = "gemini-3.5-flash";
const STUB_AUTH = { authClient: { getRequestHeaders: async () => new Headers(), getAccessToken: async () => ({ token: "stub" }) } };

type Seen = { url: string; method: string; body: Record<string, unknown> };

function stubGlobalFetch(respond: () => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, method: String(init?.method ?? "GET"), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return respond();
  });
  return seen;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Real SDK client, the app's guarded fetch untouched; only the auth client is a stub. */
const realSdkFactory = (o: GoogleGenAIOptions) => new GoogleGenAI({ ...o, googleAuthOptions: STUB_AUTH } as never);

function model(location = "global") {
  return createVertexMenuModel(
    { project: PROJECT, location, model: MODEL, attemptTimeoutMs: 20_000, requestDeadlineMs: 45_000, maxOutputTokens: 8_192 },
    realSdkFactory,
  );
}

const REQ = { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mimeType: "image/jpeg" as const, userLang: "ja" as const, storeLang: "en" as const, allergens: ["egg" as const] };
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 20_000 });

afterEach(() => vi.unstubAllGlobals());

describe("gemini-3.5-flash on the global endpoint: request built by the real SDK (no network)", () => {
  it("one POST to aiplatform.googleapis.com …/locations/global/…/gemini-3.5-flash:generateContent", async () => {
    expect(allowedVertexHost("global")).toBe("aiplatform.googleapis.com");
    const seen = stubGlobalFetch(() => jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: '{"ok":1}' }] }, finishReason: "STOP" }] }));
    await model().generate(REQ, opts());
    expect(seen).toHaveLength(1); // no SDK retry, no follow-up call
    const u = new URL(seen[0]!.url);
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("aiplatform.googleapis.com");
    expect(u.pathname).toMatch(new RegExp(`/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3\\.5-flash:generateContent$`));
    expect(seen[0]!.method).toBe("POST");
  });

  it("sends image inlineData, JSON schema structured output, the token cap and an explicit thinking level (no thinkingBudget)", async () => {
    const seen = stubGlobalFetch(() => jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: '{"ok":1}' }] }, finishReason: "STOP" }] }));
    await model().generate(REQ, opts());
    const body = seen[0]!.body as {
      contents: { role: string; parts: Record<string, unknown>[] }[];
      generationConfig: Record<string, unknown>;
      systemInstruction?: unknown;
    };
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]!.parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: Buffer.from(REQ.image).toString("base64") } });
    expect(body.systemInstruction).toBeDefined();
    const g = body.generationConfig;
    expect(g.responseMimeType).toBe("application/json");
    expect(g.responseJsonSchema).toEqual(MODEL_RESPONSE_JSON_SCHEMA);
    expect(g).not.toHaveProperty("responseSchema"); // only one schema form
    expect(g.maxOutputTokens).toBe(8_192);
    expect(g.candidateCount).toBe(1);
    expect(g.temperature).toBe(1); // explicit Gemini 3 default (D-032)
    expect(g.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM", includeThoughts: false });
    expect(g.thinkingConfig).not.toHaveProperty("thinkingBudget");
  });
});

describe("gemini-3.5-flash response shapes (synthetic bodies)", () => {
  it("text part carrying thoughtSignature + a thought part: only the non-thought text is used", async () => {
    stubGlobalFetch(() =>
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ thought: true, text: "reasoning", thoughtSignature: "c2ln" }, { text: '{"ok":', thoughtSignature: "c2ln" }, { text: "1}" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300, thoughtsTokenCount: 900, totalTokenCount: 2700 },
      }),
    );
    const r = await model().generate(REQ, opts());
    expect(r).toEqual({ text: '{"ok":1}', finishReason: "STOP", blockReason: undefined });
  });

  it("MAX_TOKENS (e.g. thinking consumed the cap) is passed on as a non-STOP finish → the runner fails closed", async () => {
    stubGlobalFetch(() => jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: '{"ok":' }] }, finishReason: "MAX_TOKENS" }] }));
    const r = await model().generate(REQ, opts());
    expect(r.finishReason).toBe("MAX_TOKENS");
  });

  it("an unknown future finishReason is reported only as 'unknown'", async () => {
    stubGlobalFetch(() => jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: "{}" }] }, finishReason: "SOME_NEW_REASON" }] }));
    const r = await model().generate(REQ, opts());
    expect(r.finishReason).toBe("unknown");
  });

  it.each([
    [400, "INVALID_ARGUMENT"],
    [403, "PERMISSION_DENIED"],
    [404, "NOT_FOUND"],
    [429, "RESOURCE_EXHAUSTED"],
    [503, "UNAVAILABLE"],
  ])("HTTP %i from Vertex AI surfaces as an SDK error with that status (exactly one request)", async (status, code) => {
    const seen = stubGlobalFetch(() => jsonResponse({ error: { code: status, message: "synthetic", status: code } }, status));
    const err = await model()
      .generate(REQ, opts())
      .then(() => undefined, (e: unknown) => e);
    expect((err as { status?: unknown }).status).toBe(status);
    expect(seen).toHaveLength(1);
  });
});

describe("multi-region `us` endpoint is NOT usable without a code change (no network)", () => {
  it("the SDK targets aiplatform.us.rep.googleapis.com, which the guard refuses before any request", async () => {
    const seen = stubGlobalFetch(() => jsonResponse({}));
    const err = await model("us")
      .generate(REQ, opts())
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(EndpointNotAllowedError);
    expect(seen).toHaveLength(0);
  });

  it("direct check: the guard refuses the us multi-region host", async () => {
    const guarded = createGuardedFetch("us", async () => new Response("{}"));
    await expect(guarded("https://aiplatform.us.rep.googleapis.com/v1/x:generateContent", { method: "POST" })).rejects.toBeInstanceOf(EndpointNotAllowedError);
  });
});
