import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAnalyzeMenu } from "@/server/analyzeMenu";
import * as body from "@/server/requestBody";
import * as config from "@/server/config";
import * as usage from "@/server/usage/guard";
import * as vertex from "@/server/gemini/vertexClient";
import { POST } from "@/app/api/analyze-menu/route";

// SYNTHETIC TEST DATA. No credentials, database, or model calls.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("card_only public API", () => {
  it.each([undefined, "false", "TRUE", "1", ""])("rejects before body/config/SDK/store with GEMINI_ENABLED=%s", async (enabled) => {
    const read = vi.spyOn(body, "readBoundedMultipart");
    const cfg = vi.spyOn(config, "readGeminiConfig");
    const store = vi.spyOn(usage, "readUsageConfig");
    const model = vi.spyOn(vertex, "getVertexMenuModel");
    const req = new Request("http://localhost/api/analyze-menu", {
      method: "POST",
      headers: { "content-length": "9999999999", "x-mock-scenario": "ok" },
    });
    Object.defineProperty(req, "body", { get: () => { throw new Error("body touched"); } });
    const res = await handleAnalyzeMenu(req, {
      NODE_ENV: "production", GEMINI_ENABLED: enabled, MOCK_GEMINI: "true",
      GOOGLE_CLOUD_PROJECT: "synthetic-project", GOOGLE_CLOUD_LOCATION: "global",
      GEMINI_MODEL: "synthetic-model", USAGE_STORE: "firestore", DAILY_INFERENCE_LIMIT: "100",
    }, { logger: vi.fn() });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error.code).toBe("AI_DISABLED");
    for (const spy of [read, cfg, store, model]) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated route request without reading a stalled stream", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEMINI_ENABLED", "false");
    vi.stubEnv("MOCK_GEMINI", "true");
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
    const req = new Request("http://localhost/api/analyze-menu", {
      method: "POST", body: stream, duplex: "half",
      headers: { "content-type": "multipart/form-data; boundary=synthetic" },
    } as RequestInit);
    const res = await POST(req);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("AI_DISABLED");
    expect(pull).not.toHaveBeenCalled();
  });

  it("keeps the production Firestore gate closed if the kill switch is misconfigured on", async () => {
    expect(usage.FIRESTORE_STORE_PRODUCTION_APPROVED).toBe(false);
    const factory = vi.fn(() => { throw new Error("Firestore initialised"); });
    const result = usage.readUsageConfig({
      NODE_ENV: "production", GEMINI_ENABLED: "true", USAGE_STORE: "firestore",
      GOOGLE_CLOUD_PROJECT: "synthetic-project", DAILY_INFERENCE_LIMIT: "100",
    }, { firestore: factory });
    expect(result).toEqual({ ok: false, failure: "usage_store_unavailable" });
    expect(factory).not.toHaveBeenCalled();
  });
});
