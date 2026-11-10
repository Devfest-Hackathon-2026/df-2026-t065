import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini } from "@/server/gemini/analyzeWithGemini";
import type { ModelCallResult } from "@/server/gemini/vertexClient";
import { FirestoreUsageStore, FirestoreUsageStoreError, ROLLBACK_TIMEOUT_MS } from "@/server/usage/firestoreStore";
import { UsageGuard, jstDayKey } from "@/server/usage/guard";
import { storedUnits } from "./contract";
import { DAY, FakeFirestoreGrpcServer, grpcEnv, wellFormedDoc, type ReadScript } from "./firestoreFakes";

/*
 * PR-F2, 3rd audit: integrity of the BatchGetDocuments response stream, field names
 * of the stored document, and best-effort Rollback — on the PRODUCTION connector
 * (real GAPIC client, google-gax 6.16.0, gRPC) against a LOCAL fake gRPC server.
 * TEST ONLY — not Firestore. Synthetic data.
 *
 * MAJOR reproduction fixed here: stored count 5, limit 5, the read stream answers
 * `found` THEN `missing` — the old code let the later `missing` overwrite the
 * `found`, allowed the call and committed count=1 (5 → 1), and the runner started
 * the model. Any malformed stream must now be refused BEFORE a commit.
 */

process.env.METADATA_SERVER_DETECTION = "none";

const server = new FakeFirestoreGrpcServer();
const stores: FirestoreUsageStore[] = [];
beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await Promise.all(stores.map((s) => s.close()));
  server.stop();
});

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const EXP = T0 + DAY;
const reasonOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof FirestoreUsageStoreError ? e.reason : `other:${String(e)}`));

function setup(stored?: number, key = "k") {
  const env = grpcEnv(server, stores);
  env.setNow(T0);
  if (stored !== undefined) env.backend.setRaw(key, stored);
  return { env, store: env.newStore() as FirestoreUsageStore, before: env.backend.snapshot() };
}
const r = (o: Record<string, unknown>) => o;

// Each script answers the NEXT read; `c.found` is the stored document, `c.tx` the started transaction (base64).
const MALFORMED: [string, ReadScript, { rollback: boolean }][] = [
  ["1 found → missing (the audit reproduction)", (c) => ({ responses: [r({ found: c.found, transaction: c.tx, readTime: c.readTime }), r({ missing: c.name, readTime: c.readTime })] }), { rollback: true }],
  ["2 missing → found", (c) => ({ responses: [r({ missing: c.name, transaction: c.tx, readTime: c.readTime }), r({ found: c.found, readTime: c.readTime })] }), { rollback: true }],
  ["3 found → found", (c) => ({ responses: [r({ found: c.found, transaction: c.tx, readTime: c.readTime }), r({ found: c.found, readTime: c.readTime })] }), { rollback: true }],
  ["4 missing → missing", (c) => ({ responses: [r({ missing: c.name, transaction: c.tx, readTime: c.readTime }), r({ missing: c.name, readTime: c.readTime })] }), { rollback: true }],
  ["5 the transaction id changes mid-stream", (c) => ({ responses: [r({ transaction: c.tx, readTime: c.readTime }), r({ found: c.found, transaction: c.otherTx, readTime: c.readTime })] }), { rollback: true }],
  ["6 no transaction id at all", (c) => ({ responses: [r({ found: c.found, readTime: c.readTime })] }), { rollback: false }],
  ["6b the transaction id only in a LATER response", (c) => ({ responses: [r({ found: c.found, readTime: c.readTime }), r({ transaction: c.tx, readTime: c.readTime })] }), { rollback: false }],
  ["7 another document's name", (c) => ({ responses: [r({ found: { ...(c.found as object), name: `${c.name}x` }, transaction: c.tx, readTime: c.readTime })] }), { rollback: true }],
  ["7b missing for another name", (c) => ({ responses: [r({ missing: `${c.name}x`, transaction: c.tx, readTime: c.readTime })] }), { rollback: true }],
  ["8 found AND missing in one response", (c) => ({ responses: [r({ found: c.found, missing: c.name, transaction: c.tx, readTime: c.readTime })] }), { rollback: true }],
  ["9 an empty response after the result", (c) => ({ responses: [r({ found: c.found, transaction: c.tx, readTime: c.readTime }), r({ readTime: c.readTime })] }), { rollback: true }],
  ["9b only a transaction, no result", (c) => ({ responses: [r({ transaction: c.tx, readTime: c.readTime })] }), { rollback: true }],
];

describe("BatchGetDocuments response integrity (MAJOR, 3rd audit) — production connector × fake gRPC server", () => {
  it("THE REPRODUCTION: stored 5, limit 5, found → missing: refused, NO commit, stored value stays 5 (never 5 → 1)", async () => {
    const { env, store } = setup(5);
    server.injectReadScript(MALFORMED[0]![1]);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("invalid_response");
    expect(server.commitRpcs).toBe(0);
    expect(storedUnits(env.backend.observe("k"), { mustExist: true })).toBe(5);
    expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: false, count: 5 }); // a normal read afterwards: still at the limit
  });

  it.each(MALFORMED)("%s → invalid_response, 0 commits, stored state unchanged, rollback of a started transaction", async (_n, script, o) => {
    const { env, store, before } = setup(3);
    server.injectReadScript(script);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("invalid_response");
    expect(server.commitRpcs).toBe(0);
    expect(env.backend.snapshot()).toEqual(before);
    for (let i = 0; i < 100 && server.rollbackRpcs < (o.rollback ? 1 : 0); i++) await new Promise((res) => setTimeout(res, 10));
    expect(server.rollbackRpcs).toBe(o.rollback ? 1 : 0);
    if (o.rollback) expect(server.rollbackTxs[0]).not.toBe(""); // the id the stream revealed
  });

  it("9 a stream that FAILS after revealing the transaction → unknown_outcome, 0 commits, the transaction IS rolled back (MINOR-3)", async () => {
    const { env, store, before } = setup(3);
    server.injectReadScript((c) => ({ responses: [r({ found: c.found, transaction: c.tx, readTime: c.readTime })], thenError: true }));
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    expect(server.commitRpcs).toBe(0);
    expect(env.backend.snapshot()).toEqual(before);
    for (let i = 0; i < 100 && server.rollbackRpcs < 1; i++) await new Promise((res) => setTimeout(res, 10));
    expect(server.rollbackRpcs).toBe(1);
  });

  it("a stream that fails BEFORE any transaction id (PERMISSION_DENIED, not retried) → unknown_outcome, 0 commits, NO rollback", async () => {
    const { store } = setup(3);
    server.injectRead("read_permission_denied");
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    await new Promise((res) => setTimeout(res, 200));
    expect(server.commitRpcs).toBe(0);
    expect(server.rollbackRpcs).toBe(0);
  });

  it("a read that fails with UNAVAILABLE before any data is NOT re-sent (one BatchGet RPC, single attempt, bounded)", async () => {
    const { store } = setup(3);
    server.injectRead("read_unavailable");
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    await new Promise((res) => setTimeout(res, 300));
    expect(server.batchGetRpcs).toBe(1);
    expect(server.commitRpcs).toBe(0);
    expect(server.rollbackRpcs).toBe(0);
  });

  it.each([
    ["10 a single found", (c: Parameters<ReadScript>[0]) => ({ responses: [r({ found: c.found, transaction: c.tx, readTime: c.readTime })] }), 3, 4],
    ["10 a single missing", (c: Parameters<ReadScript>[0]) => ({ responses: [r({ missing: c.name, transaction: c.tx, readTime: c.readTime })] }), undefined, 1],
    ["10 a transaction-only first response, then the found", (c: Parameters<ReadScript>[0]) => ({ responses: [r({ transaction: c.tx, readTime: c.readTime }), r({ found: c.found, readTime: c.readTime })] }), 3, 4],
    ["10 the SAME transaction id repeated with the result", (c: Parameters<ReadScript>[0]) => ({ responses: [r({ transaction: c.tx, readTime: c.readTime }), r({ found: c.found, transaction: c.tx, readTime: c.readTime })] }), 3, 4],
  ])("%s → accepted (valid orders are not refused), exactly one commit", async (_n, script, stored, expected) => {
    const { env, store } = setup(stored);
    server.injectReadScript(script as ReadScript);
    expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: true, count: expected });
    expect(server.commitRpcs).toBe(1);
    expect(storedUnits(env.backend.observe("k"), { mustExist: true })).toBe(expected);
  });

  it("through the guard and the runner: stored 5 / limit 5 / found → missing → AI_DISABLED, 0 model starts, unknown counted, stored stays 5", async () => {
    const key = `daily:${jstDayKey(T0)}`;
    const { env, store } = setup(5, key);
    server.injectReadScript(MALFORMED[0]![1]);
    let starts = 0;
    const ok: ModelCallResult = { text: "{}", finishReason: "STOP" };
    const cfg: GeminiConfig = { project: "demo-allergy-bridge", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
    const g = new UsageGuard(store, { dailyInferenceLimit: 5, ratePerMinute: 60, trustedProxyHops: 0 }, env.now);
    const out = await analyzeWithGemini(
      { generate: async () => (starts++, ok) },
      cfg,
      { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg", userLang: "ja", storeLang: "en", allergens: ["peanut"] },
      { requestId: "r", deadlineAt: T0 + 8000, reserveAttempt: (d) => g.reserveInference(d) },
      { now: env.now },
    );
    expect(starts).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "AI_DISABLED", failure: "usage_store_error", reserved: 0, reservationsUnknown: 1 });
    expect(server.commitRpcs).toBe(0);
    expect(storedUnits(env.backend.observe(key), { mustExist: true })).toBe(5);
  });
});

describe("stored field names are preserved exactly (MINOR-2) — production connector × fake gRPC server", () => {
  const extra = (json: string) => JSON.parse(json) as Record<string, unknown>; // JSON.parse keeps "__proto__" as an own key
  it.each([
    ["__proto__ added", extra('{"__proto__": 1}')],
    ["constructor added", extra('{"constructor": 1}')],
    ["prototype added", extra('{"prototype": 1}')],
    ["an ordinary extra field", { note: "x" }],
  ])("%s → corrupt, 0 commits, stored state unchanged", async (_n, more) => {
    const { env, store } = setup();
    server.setFields("k", { ...wellFormedDoc(3, T0), ...more });
    const before = env.backend.snapshot();
    const fieldsBefore = JSON.stringify(Object.keys(server.docs.get(server.docName("k"))!.fields));
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("corrupt");
    expect(server.commitRpcs).toBe(0);
    expect(env.backend.snapshot()).toEqual(before);
    expect(JSON.stringify(Object.keys(server.docs.get(server.docName("k"))!.fields))).toBe(fieldsBefore);
  });

  it.each([
    ["a required key missing (deleteAfter)", () => {
      const d = wellFormedDoc(3, T0);
      delete d.deleteAfter;
      return d;
    }],
    ["a wrong value type (count as a string)", () => wellFormedDoc("3", T0)],
  ])("%s → corrupt, 0 commits", async (_n, mk) => {
    const { store } = setup();
    server.setFields("k", mk());
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("corrupt");
    expect(server.commitRpcs).toBe(0);
  });

  it("a well-formed document → accepted", async () => {
    const { store } = setup();
    server.setFields("k", wellFormedDoc(3, T0));
    expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: true, count: 4 });
  });
});

describe("best-effort Rollback and close() (MINOR-3) — production connector × fake gRPC server", () => {
  const failAfterTx: ReadScript = (c) => ({ responses: [r({ found: c.found, transaction: c.tx, readTime: c.readTime })], thenError: true });

  it("a REJECTING rollback is handled (no unhandled rejection) and never replaces the primary error", async () => {
    const { store } = setup(3);
    server.failRollback = true;
    server.injectReadScript(failAfterTx);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome"); // the read's error, not the rollback's
    for (let i = 0; i < 100 && server.rollbackRpcs < 1; i++) await new Promise((res) => setTimeout(res, 10));
    expect(server.rollbackRpcs).toBe(1); // single attempt (no retry)
    await new Promise((res) => setTimeout(res, 100)); // Vitest fails the run on any unhandled rejection
  });

  it("close() right after the failure WAITS for the running (delayed) rollback before closing the client", async () => {
    const { store } = setup(3);
    server.rollbackDelayMs = 800;
    server.injectReadScript(failAfterTx);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    const t = Date.now();
    await store.close();
    expect(Date.now() - t).toBeGreaterThanOrEqual(500); // waited for the rollback
    expect(server.rollbackRpcs).toBe(1);
  });

  it("a delayed rollback FAILURE during close() is handled", async () => {
    const { store } = setup(3);
    server.rollbackDelayMs = 500;
    server.failRollback = true;
    server.injectReadScript(failAfterTx);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    await store.close();
    expect(server.rollbackRpcs).toBe(1);
  });

  it(`a rollback that NEVER answers is bounded: close() finishes within the rollback timeout (${ROLLBACK_TIMEOUT_MS} ms)`, async () => {
    const { store } = setup(3);
    server.rollbackHang = true;
    server.injectReadScript(failAfterTx);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    // Race against a bound so an unbounded close() FAILS this assertion (not merely the test timeout).
    const outcome = await Promise.race([store.close().then(() => "closed"), new Promise((res) => setTimeout(() => res("still waiting"), ROLLBACK_TIMEOUT_MS + 3_000))]);
    expect(outcome).toBe("closed");
    expect(server.rollbackRpcs).toBe(1);
  }, 20_000);
});
