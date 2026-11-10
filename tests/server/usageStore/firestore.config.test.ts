import { Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { AnalyzeMenuErrorSchema } from "@/contracts/analyze";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import type { ModelCallResult } from "@/server/gemini/vertexClient";
import { FirestoreUsageStore, getFirestoreUsageStore, usageDocId, USAGE_COLLECTION, type TimestampClass } from "@/server/usage/firestoreStore";
import { FIRESTORE_STORE_PRODUCTION_APPROVED, jstDayKey, readUsageConfig, type UsageEnv } from "@/server/usage/guard";
import { blob, fakeJpeg } from "../helpers";
import { FakeFirestoreApi } from "./firestoreFakes";

/*
 * USAGE_STORE=firestore wiring (readUsageConfig and the analyze route). No real
 * Firestore, no network: factories are test doubles over FakeFirestoreApi, and the
 * default factory is only constructed (its client is created on the first consume,
 * which these tests never reach). Model outputs are SYNTHETIC.
 */

const BASE: UsageEnv = { GEMINI_ENABLED: "true", USAGE_STORE: "firestore", DAILY_INFERENCE_LIMIT: "10", GOOGLE_CLOUD_PROJECT: "demo-allergy-bridge" };
const TS = Timestamp as unknown as TimestampClass;

describe("readUsageConfig: USAGE_STORE=firestore", () => {
  it("is NOT approved for production (constant false) → usage_store_unavailable, the factory is never called", () => {
    expect(FIRESTORE_STORE_PRODUCTION_APPROVED).toBe(false);
    let called = 0;
    const r = readUsageConfig({ ...BASE, NODE_ENV: "production" }, { firestore: () => (called++, new FirestoreUsageStore(async () => Promise.reject(new Error("x")))) });
    expect(r).toEqual({ ok: false, failure: "usage_store_unavailable" });
    expect(called).toBe(0);
    expect(readUsageConfig({ ...BASE, NODE_ENV: undefined })).toEqual({ ok: false, failure: "usage_store_unavailable" });
    expect(readUsageConfig({ ...BASE, NODE_ENV: "staging" })).toEqual({ ok: false, failure: "usage_store_unavailable" });
  });

  it("the kill switch still comes first (production default = AI_DISABLED / kill_switch_off)", () => {
    expect(readUsageConfig({ ...BASE, NODE_ENV: "production", GEMINI_ENABLED: undefined })).toEqual({ ok: false, failure: "kill_switch_off" });
    expect(readUsageConfig({ ...BASE, NODE_ENV: "development", GEMINI_ENABLED: "TRUE" })).toEqual({ ok: false, failure: "kill_switch_off" });
  });

  it("FIRESTORE_EMULATOR_HOST outside development/test → usage_config_invalid (the SDK would send unauthenticated requests there)", () => {
    expect(readUsageConfig({ ...BASE, NODE_ENV: "production", FIRESTORE_EMULATOR_HOST: "10.0.0.1:8080" })).toEqual({ ok: false, failure: "usage_config_invalid" });
    expect(readUsageConfig({ ...BASE, NODE_ENV: "production", FIRESTORE_EMULATOR_HOST: "   " })).toEqual({ ok: false, failure: "usage_store_unavailable" }); // blank = unset, as the SDK treats it… still refused in production
  });

  it.each([undefined, "", "P", "a", "has_underscore", "-leading", "x".repeat(31), "ok-project-"])("an invalid GOOGLE_CLOUD_PROJECT (%s) → usage_config_invalid (fail closed)", (project) => {
    expect(readUsageConfig({ ...BASE, NODE_ENV: "development", GOOGLE_CLOUD_PROJECT: project })).toEqual({ ok: false, failure: "usage_config_invalid" });
  });

  it("development: the default factory returns the process-wide store (reused), WITHOUT creating a client", () => {
    const a = readUsageConfig({ ...BASE, NODE_ENV: "development" });
    const b = readUsageConfig({ ...BASE, NODE_ENV: "test" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.store.kind).toBe("firestore");
    expect(a.store).toBe(b.store);
    expect(a.store).toBe(getFirestoreUsageStore("demo-allergy-bridge"));
    expect(getFirestoreUsageStore("other-demo-project")).not.toBe(a.store);
  });

  it("TRUSTED_PROXY_HOPS ≠ 0 → usage_config_invalid: identified rate keys (unkeyed IP hashes) are never persisted in Firestore", () => {
    for (const hops of ["1", "2", "3"]) expect(readUsageConfig({ ...BASE, NODE_ENV: "development", TRUSTED_PROXY_HOPS: hops })).toEqual({ ok: false, failure: "usage_config_invalid" });
    expect(readUsageConfig({ ...BASE, NODE_ENV: "development", TRUSTED_PROXY_HOPS: "0" }).ok).toBe(true);
    expect(readUsageConfig({ ...BASE, NODE_ENV: "development", USAGE_STORE: "memory", TRUSTED_PROXY_HOPS: "1" }).ok).toBe(true); // memory store unchanged
  });

  it("a factory that throws → usage_store_error", () => {
    expect(readUsageConfig({ ...BASE, NODE_ENV: "development" }, { firestore: () => { throw new Error("x"); } })).toEqual({ ok: false, failure: "usage_store_error" });
  });

  it("unknown / differently cased store names are refused (no implicit fallback)", () => {
    for (const name of ["Firestore", "FIRESTORE", "firestore ", "datastore", ""]) {
      expect(readUsageConfig({ ...BASE, NODE_ENV: "development", USAGE_STORE: name })).toEqual({ ok: false, failure: "usage_store_unavailable" });
    }
  });
});

// ---------------------------------------------------------------------------
// The analyze route (public response contract unchanged)
// ---------------------------------------------------------------------------

const CFG: GeminiConfig = { project: "demo-allergy-bridge", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const OK: ModelCallResult = {
  text: JSON.stringify({ status: "ok", imageIssues: [], items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }], menuNotices: [] }),
  finishReason: "STOP",
};
function request(): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}
const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);

describe("analyze route with USAGE_STORE=firestore", () => {
  it("production: AI_DISABLED (503 body per the public contract), 0 model calls, the store is never created", async () => {
    let calls = 0;
    let created = 0;
    const res = await handleAnalyzeMenu(request(), { ...(BASE as AnalyzeEnv), NODE_ENV: "production" }, {
      config: CFG,
      model: { generate: async () => (calls++, OK) },
      usageStores: { firestore: () => (created++, new FirestoreUsageStore(async () => ({ db: new FakeFirestoreApi(), Timestamp: TS }))) },
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
    expect(created).toBe(0);
  });

  it("development, Firestore client init fails → AI_DISABLED, 0 model calls", async () => {
    let calls = 0;
    const res = await handleAnalyzeMenu(request(), { ...(BASE as AnalyzeEnv), NODE_ENV: "development" }, {
      config: CFG,
      model: { generate: async () => (calls++, OK) },
      usageStores: { firestore: () => new FirestoreUsageStore(async () => Promise.reject(new Error("synthetic: no ADC"))) },
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
  });

  it("development, contention on the rate counter → AI_DISABLED, 0 model calls, nothing stored", async () => {
    const api = new FakeFirestoreApi();
    api.inject("aborted");
    let calls = 0;
    const res = await handleAnalyzeMenu(request(), { ...(BASE as AnalyzeEnv), NODE_ENV: "development" }, {
      config: CFG,
      now: () => T0,
      model: { generate: async () => (calls++, OK) },
      usageStores: { firestore: () => new FirestoreUsageStore(async () => ({ db: api, Timestamp: TS }), () => T0) },
    });
    expect(AnalyzeMenuErrorSchema.parse(await res.json()).error.code).toBe("AI_DISABLED");
    expect(calls).toBe(0);
    expect(api.docs.size).toBe(0);
  });

  it("development, working store: 200, ONE model call, exactly the rate and daily counters stored (+1 each), nothing else", async () => {
    const api = new FakeFirestoreApi();
    let calls = 0;
    const res = await handleAnalyzeMenu(request(), { ...(BASE as AnalyzeEnv), NODE_ENV: "development" }, {
      config: CFG,
      now: () => T0,
      model: { generate: async () => (calls++, OK) },
      usageStores: { firestore: () => new FirestoreUsageStore(async () => ({ db: api, Timestamp: TS }), () => T0) },
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    const daily = `${USAGE_COLLECTION}/${usageDocId(`daily:${jstDayKey(T0)}`)}`;
    expect([...api.docs.keys()]).toHaveLength(2);
    expect((api.docs.get(daily)!.data as Record<string, unknown>).count).toBe(1);
    const rate = [...api.docs.entries()].find(([k]) => k !== daily)!;
    expect(Buffer.from(rate[0].split("/")[1]!.slice(3), "base64url").toString("ascii")).toMatch(/^rate:[^:]+:\d+$/);
    expect((rate[1].data as Record<string, unknown>).count).toBe(1);
    // only counters and expiries are stored (no image, menu text, allergen or client IP)
    for (const d of api.docs.values()) expect(Object.keys(d.data as object).sort()).toEqual(["count", "deleteAfter", "expiresAt", "v"]);
  });

  it("mock mode is unchanged: MOCK_GEMINI=true in development serves the fixture; the Firestore store is never created", async () => {
    let created = 0;
    const res = await handleAnalyzeMenu(request(), { ...(BASE as AnalyzeEnv), NODE_ENV: "development", MOCK_GEMINI: "true" }, {
      usageStores: { firestore: () => (created++, new FirestoreUsageStore(async () => Promise.reject(new Error("x")))) },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dataOrigin?: string }).dataOrigin).toBe("mock_fixture");
    expect(created).toBe(0);
  });
});
