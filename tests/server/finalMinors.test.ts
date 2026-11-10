import http from "node:http";
import type { AddressInfo } from "node:net";
import { GoogleAuth } from "google-auth-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini } from "@/server/gemini/analyzeWithGemini";
import { EndpointNotAllowedError, createGuardedFetch, createVertexMenuModel } from "@/server/gemini/vertexClient";
import type { LogEvent } from "@/server/log";
import { blob, fakeJpeg, PERMIT } from "./helpers";

/*
 * Final PR2 MINOR fixes:
 *  m-1  the guarded fetch never follows redirects (no ADC token to another host)
 *  m-2  a refused endpoint override is logged as "endpoint_override_blocked"
 * No real ADC token, no Gemini call: fetch / auth are test doubles; the only real
 * sockets are two local HTTP servers on 127.0.0.1 used to observe real fetch behaviour.
 */

const ALLOWED = "https://asia-northeast1-aiplatform.googleapis.com/v1beta1/projects/p/locations/asia-northeast1/publishers/google/models/m:generateContent";
const CFG: GeminiConfig = { project: "proj-secret-123", location: "asia-northeast1", model: "model-y", attemptTimeoutMs: 1000, requestDeadlineMs: 5000, maxOutputTokens: 4096 };
const REQ = { image: fakeJpeg(), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };

describe("m-1: the guarded fetch does not follow redirects", () => {
  it("always passes redirect: 'error' to the underlying fetch (string, URL and Request inputs)", async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    const base = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response("{}");
    });
    const guarded = createGuardedFetch("asia-northeast1", base as unknown as typeof fetch);
    await guarded(ALLOWED, { method: "POST", redirect: "follow" }); // a caller asking to follow is overridden
    await guarded(new URL(ALLOWED));
    await guarded(new Request(ALLOWED, { redirect: "follow" }));
    expect(seen).toEqual(["error", "error", "error"]);
  });

  it("still rejects disallowed endpoints before any request is made", async () => {
    const base = vi.fn();
    const guarded = createGuardedFetch("asia-northeast1", base as unknown as typeof fetch);
    for (const u of ["https://attacker.example/x", "http://asia-northeast1-aiplatform.googleapis.com/x", "https://us-central1-aiplatform.googleapis.com/x"]) {
      await expect(guarded(u)).rejects.toBeInstanceOf(EndpointNotAllowedError);
    }
    expect(base).not.toHaveBeenCalled();
  });

  it.each([301, 302, 303, 307, 308])("a %i response that reaches the guard is refused (never followed)", async (status) => {
    const base = vi.fn(async () => new Response(null, { status, headers: { location: "https://attacker.example/steal" } }));
    const guarded = createGuardedFetch("asia-northeast1", base as unknown as typeof fetch);
    await expect(guarded(ALLOWED)).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(base).toHaveBeenCalledTimes(1);
  });

  describe("with the real Node fetch against local servers", () => {
    let target: http.Server;
    let redirector: http.Server;
    const targetHits: (string | null)[] = [];
    let targetUrl = "";
    let redirectorUrl = "";
    beforeAll(async () => {
      target = http.createServer((req, res) => {
        targetHits.push(req.headers.authorization ?? null);
        res.end("token received");
      });
      await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
      targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/steal`;
      redirector = http.createServer((req, res) => {
        res.writeHead(Number(req.url!.slice(1)), { location: targetUrl });
        res.end();
      });
      await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
      redirectorUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      target.close();
      redirector.close();
    });

    it.each([302, 307])("a %i from the (allowed) endpoint is not followed and the Authorization header is not forwarded", async (status) => {
      targetHits.length = 0;
      // The guard checks the allowed URL; the underlying real fetch is pointed at the local redirector.
      const viaLocal = ((_i: RequestInfo | URL, init?: RequestInit) => fetch(`${redirectorUrl}/${status}`, init)) as typeof fetch;
      const guarded = createGuardedFetch("asia-northeast1", viaLocal);
      await expect(guarded(ALLOWED, { method: "POST", body: "{}", headers: { authorization: "Bearer FAKE-ADC-TOKEN" } })).rejects.toBeInstanceOf(
        EndpointNotAllowedError,
      );
      expect(targetHits).toEqual([]); // the redirect target was never contacted
    });
  });

  describe("through the real SDK and the runner (fails safe, no retry)", () => {
    const sent: { url: string; redirect?: RequestRedirect }[] = [];
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    it.each([302, 307])("a %i is mapped to AI_DISABLED with a single attempt", async (status) => {
      sent.length = 0;
      vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers({ authorization: "Bearer FAKE-ADC-TOKEN" }) as never);
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), redirect: init.redirect });
        // Emulate undici: with redirect "error" a redirect response becomes a TypeError.
        if (init.redirect === "error") throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
        return new Response(null, { status, headers: { location: "https://attacker.example/" } });
      });
      const r = await analyzeWithGemini(createVertexMenuModel(CFG), CFG, REQ, { requestId: "r", reserveAttempt: async () => PERMIT }, { sleep: async () => {} });
      expect(r).toMatchObject({ ok: false, code: "AI_DISABLED", attempts: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.redirect).toBe("error");
      expect(new URL(sent[0]!.url).hostname).toBe("asia-northeast1-aiplatform.googleapis.com");
    });

    it("an ordinary network error is still retried once (behaviour unchanged)", async () => {
      sent.length = 0;
      vi.spyOn(GoogleAuth.prototype, "getRequestHeaders").mockResolvedValue(new Headers({ authorization: "Bearer FAKE-ADC-TOKEN" }) as never);
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), redirect: init.redirect });
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      });
      const r = await analyzeWithGemini(createVertexMenuModel(CFG), CFG, REQ, { requestId: "r", reserveAttempt: async () => PERMIT }, { sleep: async () => {} });
      expect(r).toMatchObject({ ok: false, code: "AI_FAILED", attempts: 2 });
    });
  });
});

describe("m-2: endpoint override refusal is logged distinctly", () => {
  const BASE = { NODE_ENV: "production", GEMINI_ENABLED: "true", GOOGLE_CLOUD_PROJECT: "proj-secret-123", GOOGLE_CLOUD_LOCATION: "asia-northeast1", GEMINI_MODEL: "model-y" };
  function request(): Request {
    const f = new FormData();
    f.append("userLang", "ja");
    f.append("storeLang", "en");
    f.append("allergens", "peanut");
    f.append("allergens", "sesame");
    const img = fakeJpeg(128);
    img.set(new TextEncoder().encode("UNIQUEIMAGEMARKER"), 20);
    f.append("image", blob(img, "image/jpeg"), "m.jpg");
    return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
  }

  it.each(["GOOGLE_VERTEX_BASE_URL", "google_gemini_base_url"])("%s set → failure 'endpoint_override_blocked', HTTP stays AI_DISABLED", async (name) => {
    const logs: LogEvent[] = [];
    const res = await handleAnalyzeMenu(request(), { ...BASE, [name]: "https://attacker.example/secret-path?token=abc" } as AnalyzeEnv, {
      logger: (e) => logs.push(e),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ requestId: expect.any(String), error: { code: "AI_DISABLED", retryable: false } });
    expect(logs).toEqual([expect.objectContaining({ outcome: "error", errorCode: "AI_DISABLED", failure: "endpoint_override_blocked" })]);
  });

  it("missing configuration is still logged as 'not_configured'", async () => {
    const logs: LogEvent[] = [];
    await handleAnalyzeMenu(request(), { NODE_ENV: "production", GEMINI_ENABLED: "true" }, { logger: (e) => logs.push(e) });
    expect(logs[0]).toMatchObject({ failure: "not_configured", errorCode: "AI_DISABLED" });
  });

  it("an override AND missing values → the override reason wins (more specific, still no values logged)", async () => {
    const logs: LogEvent[] = [];
    await handleAnalyzeMenu(request(), { NODE_ENV: "production", GEMINI_ENABLED: "true", GOOGLE_VERTEX_BASE_URL: "https://attacker.example/" }, { logger: (e) => logs.push(e) });
    expect(logs[0]).toMatchObject({ failure: "endpoint_override_blocked" });
  });

  it("the written log line contains only allow-listed keys and no URL, token, project, image or allergen data", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.map(String).join(" ")));
    await handleAnalyzeMenu(request(), { ...BASE, GOOGLE_VERTEX_BASE_URL: "https://attacker.example/secret-path?token=abc" } as AnalyzeEnv);
    vi.restoreAllMocks();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    for (const forbidden of ["attacker", "secret-path", "token=abc", "proj-secret-123", "UNIQUEIMAGEMARKER", "peanut", "sesame", "Bearer"]) {
      expect(line).not.toContain(forbidden);
    }
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.failure).toBe("endpoint_override_blocked");
    expect(Object.keys(parsed).sort()).toEqual(["errorCode", "event", "failure", "latencyMs", "mock", "outcome", "requestId"]);
  });
});
