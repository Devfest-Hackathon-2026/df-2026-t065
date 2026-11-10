import { Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import {
  FirestoreUsageStore,
  FirestoreUsageStoreError,
  TTL_RETENTION_MS,
  USAGE_COLLECTION,
  usageDocId,
  type FirestoreDeps,
  type TimestampClass,
} from "@/server/usage/firestoreStore";
import { UsageGuard, jstDayKey } from "@/server/usage/guard";
import { UsageStoreInputError, assertConsumeResult } from "@/server/usage/store";
import { settleUntrusted } from "@/server/untrusted";
import { describeSharedUsageStoreContract, verifyGuardedLostCommit, verifyLostCommitResponse } from "./contract";
import { DAY, FakeFirestoreApi, fakeApiEnv, sdkLikeError, wellFormedDoc } from "./firestoreFakes";

/*
 * FirestoreUsageStore — UNIT level, over FakeFirestoreApi (a fake of the Firestore
 * API surface; NO SDK code, NOT Firestore). The shared UsageStore contract
 * (C1–C10, S1–S5, mandatory capabilities, no skip path) plus Firestore-specific
 * checks: document IDs, the stored schema, expiry, lazy initialisation, error
 * classification, and the transaction options.
 */

describeSharedUsageStoreContract(() => fakeApiEnv());

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const EXP = T0 + DAY;
const TS = Timestamp as unknown as TimestampClass;
const LIMITS = { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 };

function setup() {
  const env = fakeApiEnv();
  env.setNow(T0);
  return { env, api: env.api, store: env.newStore(), path: (key: string) => `${USAGE_COLLECTION}/${usageDocId(key)}` };
}

describe("FirestoreUsageStore (unit, fake API): document IDs", () => {
  it("are injective, Firestore-safe and stable", () => {
    const keys = ["daily:2026-11-07", "rate:abc:29600000", "a/b", "a.b", "..", "__x__", "a", "A", "aa", "a=", "~!@#$%^&*()"];
    const ids = keys.map(usageDocId);
    expect(new Set(ids).size).toBe(keys.length);
    for (const id of ids) {
      expect(id).toMatch(/^u1_[A-Za-z0-9_-]+$/); // never "/", never "." / "..", never "__…__"
      expect(id.length).toBeLessThan(400);
    }
    expect(usageDocId("daily:2026-11-07")).toBe(usageDocId("daily:2026-11-07"));
  });

  it.each([["empty", ""], ["space", "a b"], ["non-ASCII", "日次"], ["control char", "a\nb"], ["too long", "k".repeat(257)], ["not a string", 5]])(
    "an invalid key (%s) → UsageStoreInputError; Firestore is NOT initialised or accessed",
    async (_n, key) => {
      const { env, api, store } = setup();
      await expect(store.consume(key as string, 1, 5, EXP)).rejects.toBeInstanceOf(UsageStoreInputError);
      expect(env.connects()).toBe(0);
      expect(api.attempts).toBe(0);
    },
  );

  it("invalid amount / limit / expiry never initialise or touch Firestore (non-integer and out-of-range expiry included)", async () => {
    const { env, api, store } = setup();
    for (const [a, l, e] of [[0, 5, EXP], [1, 0, EXP], [1, 5, T0], [1, 5, EXP + 0.5], [1, 5, 253_402_300_799_999]] as const) {
      await expect(store.consume("k", a, l, e)).rejects.toBeInstanceOf(UsageStoreInputError);
    }
    expect(env.connects()).toBe(0);
    expect(api.attempts).toBe(0);
  });
});

describe("FirestoreUsageStore (unit, fake API): clock", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])("an invalid clock value (%s) → UsageStoreInputError; Firestore is not initialised or accessed", async (bad) => {
    const api = new FakeFirestoreApi();
    let connects = 0;
    const store = new FirestoreUsageStore(async () => (connects++, { db: api, Timestamp: TS }), () => bad);
    await expect(store.consume("k", 1, 5, EXP)).rejects.toBeInstanceOf(UsageStoreInputError);
    expect(connects).toBe(0);
    expect(api.attempts).toBe(0);
  });
});

describe("FirestoreUsageStore (unit, fake API): stored schema", () => {
  it("writes exactly { v: 1, count, expiresAt, deleteAfter = expiresAt + 2 days } — nothing else", async () => {
    const { api, store, path } = setup();
    expect(await store.consume("k", 2, 5, EXP)).toEqual({ allowed: true, count: 2 });
    const d = api.docs.get(path("k"))!.data as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(["count", "deleteAfter", "expiresAt", "v"]);
    expect(d.v).toBe(1);
    expect(d.count).toBe(2);
    expect((d.expiresAt as Timestamp).toMillis()).toBe(EXP);
    expect((d.deleteAfter as Timestamp).toMillis()).toBe(EXP + TTL_RETENTION_MS);
  });

  it("a live document keeps its own expiry; an EXPIRED one starts a new window with the new expiry", async () => {
    const { env, api, store, path } = setup();
    await store.consume("k", 1, 2, T0 + 60_000);
    expect(await store.consume("k", 1, 2, T0 + 60_000)).toEqual({ allowed: true, count: 2 });
    env.setNow(T0 + 59_999);
    expect(await store.consume("k", 1, 2, T0 + 60_000)).toEqual({ allowed: false, count: 2 }); // 1 ms before: still counted
    env.setNow(T0 + 60_000); // exactly at the expiry
    expect(await store.consume("k", 1, 2, T0 + 120_000)).toEqual({ allowed: true, count: 1 });
    expect((api.docs.get(path("k"))!.data as Record<string, Timestamp>).expiresAt!.toMillis()).toBe(T0 + 120_000);
  });

  it("a denial writes nothing (also on an expired document and when amount > limit)", async () => {
    const { env, api, store, path } = setup();
    api.setDoc(path("k"), wellFormedDoc(5, T0));
    const before = api.docs.get(path("k"));
    expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: false, count: 5 });
    expect(api.docs.get(path("k"))).toBe(before);
    env.setNow(T0 + 60_000);
    expect(await store.consume("k", 9, 5, EXP)).toEqual({ allowed: false, count: 0 });
    expect(api.docs.get(path("k"))).toBe(before);
    expect(api.appliedCommits).toBe(0);
  });

  it("no integer overflow at the edge of the safe range", async () => {
    const { api, store, path } = setup();
    const MAX = Number.MAX_SAFE_INTEGER;
    api.setDoc(path("k"), wellFormedDoc(MAX - 1, T0));
    expect(await store.consume("k", 2, MAX, EXP)).toEqual({ allowed: false, count: MAX - 1 });
    expect(await store.consume("k", 1, MAX, EXP)).toEqual({ allowed: true, count: MAX });
    expect(await store.consume("k", MAX, MAX, EXP)).toEqual({ allowed: false, count: MAX });
  });

  const tsv = (ms: number) => Timestamp.fromMillis(ms);
  it.each([
    ["data() not an object", () => 5],
    ["data() an array", () => [1]],
    ["missing v", () => ({ count: 1, expiresAt: tsv(T0 + 60_000), deleteAfter: tsv(T0 + 60_000 + TTL_RETENTION_MS) })],
    ["schema v 2", () => ({ ...wellFormedDoc(1, T0), v: 2 })],
    ["v as a string", () => ({ ...wellFormedDoc(1, T0), v: "1" })],
    ["missing count", () => ({ v: 1, expiresAt: tsv(T0 + 60_000), deleteAfter: tsv(T0 + 60_000 + TTL_RETENTION_MS) })],
    ["extra field", () => ({ ...wellFormedDoc(1, T0), note: "x" })],
    ["count NaN", () => wellFormedDoc(Number.NaN, T0)],
    ["count Infinity", () => wellFormedDoc(Number.POSITIVE_INFINITY, T0)],
    ["count fractional", () => wellFormedDoc(1.5, T0)],
    ["count negative", () => wellFormedDoc(-1, T0)],
    ["count string", () => wellFormedDoc("1", T0)],
    ["count unsafe", () => wellFormedDoc(Number.MAX_SAFE_INTEGER + 1, T0)],
    ["expiresAt a number", () => ({ ...wellFormedDoc(1, T0), expiresAt: T0 + 60_000 })],
    ["expiresAt a Timestamp look-alike", () => ({ ...wellFormedDoc(1, T0), expiresAt: { toMillis: () => T0 + 60_000 } })],
    ["deleteAfter missing", () => ({ v: 1, count: 1, expiresAt: tsv(T0 + 60_000) })],
    ["deleteAfter ≠ expiresAt + retention", () => ({ ...wellFormedDoc(1, T0), deleteAfter: tsv(T0 + 60_000) })],
    ["live expiry LATER than the caller's", () => wellFormedDoc(1, T0, EXP + 1)],
    ["expired but malformed (count NaN) — still refused, never reset", () => wellFormedDoc(Number.NaN, T0, T0 - 1)],
  ])("corrupt document (%s) → FirestoreUsageStoreError(corrupt); never read as 0; nothing written", async (_n, mk) => {
    const { api, store, path } = setup();
    api.setDoc(path("k"), mk());
    const before = api.docs.get(path("k"));
    const err = await store.consume("k", 1, 10, EXP).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FirestoreUsageStoreError);
    expect((err as FirestoreUsageStoreError).reason).toBe("corrupt");
    expect(api.docs.get(path("k"))).toBe(before);
    expect(api.appliedCommits).toBe(0);
  });
});

describe("FirestoreUsageStore (unit, fake API): transactions, errors and initialisation", () => {
  it("every transaction is started with { maxAttempts: 1 }", async () => {
    const { api, store } = setup();
    await store.consume("a", 1, 5, EXP);
    await store.consume("b", 1, 5, EXP);
    expect(api.transactionOptions).toEqual([{ maxAttempts: 1 }, { maxAttempts: 1 }]);
  });

  it.each([
    ["ABORTED (code 10)", 10, "contention"],
    ["HTTP 409 (REST ABORTED)", 409, "contention"],
    ["DEADLINE_EXCEEDED", 4, "unknown_outcome"],
    ["UNAVAILABLE", 14, "unknown_outcome"],
    ["INTERNAL", 13, "unknown_outcome"],
    ["PERMISSION_DENIED", 7, "unknown_outcome"],
  ])("an SDK error %s → FirestoreUsageStoreError(%s) with a fixed message (no SDK details)", async (_n, code, reason) => {
    const db = { collection: () => ({ doc: (id: string) => ({ id }) }), runTransaction: async () => Promise.reject(sdkLikeError(code, "SECRET-DETAIL projects/p/databases token=abc")) };
    const store = new FirestoreUsageStore(async () => ({ db, Timestamp: TS }) as FirestoreDeps, () => T0);
    const err = (await store.consume("k", 1, 5, EXP).then(() => null, (e: unknown) => e)) as FirestoreUsageStoreError;
    expect(err).toBeInstanceOf(FirestoreUsageStoreError);
    expect(err.reason).toBe(reason);
    expect(err.message).toBe(`firestore usage store: ${reason}`);
    expect(JSON.stringify(err) + String(err) + String((err as Error).stack)).not.toMatch(/SECRET|token|projects\//);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("a thrown non-object / getter-throwing error is classified as unknown_outcome (never propagated as is)", async () => {
    const evil = Object.defineProperty({}, "code", { get: () => { throw new Error("boom"); } });
    for (const thrown of [undefined, "str", evil]) {
      const db = { collection: () => ({ doc: (id: string) => ({ id }) }), runTransaction: async () => Promise.reject(thrown) };
      const store = new FirestoreUsageStore(async () => ({ db, Timestamp: TS }) as FirestoreDeps, () => T0);
      await expect(store.consume("k", 1, 5, EXP)).rejects.toMatchObject({ reason: "unknown_outcome" });
    }
  });

  it("the client is created LAZILY (not at construction), ONCE per store, and a failed init is retried on the next call", async () => {
    let calls = 0;
    let fail = true;
    const api = new FakeFirestoreApi();
    const store = new FirestoreUsageStore(async () => {
      calls++;
      if (fail) throw new Error("synthetic init failure (no credentials)");
      return { db: api, Timestamp: TS };
    }, () => T0);
    expect(calls).toBe(0);
    await expect(store.consume("k", 1, 5, EXP)).rejects.toMatchObject({ reason: "init_failed" });
    expect(calls).toBe(1);
    fail = false;
    expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: true, count: 1 });
    expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: true, count: 2 });
    expect(calls).toBe(2); // reused after success
  });

  it.each([["connect throws synchronously", () => { throw new Error("x"); }], ["connect resolves to nothing", async () => undefined], ["connect resolves to a malformed object", async () => ({ db: null })]])(
    "init failure (%s) → init_failed; through the guard and runner: store_error, 0 model starts",
    async (_n, connect) => {
      const store = new FirestoreUsageStore(connect as unknown as () => Promise<FirestoreDeps>, () => T0);
      await expect(store.consume("k", 1, 5, EXP)).rejects.toMatchObject({ reason: "init_failed" });
      const g = new UsageGuard(store, LIMITS, () => T0);
      expect(await g.checkRate("c", T0 + 5_000)).toBe("store_error");
      expect(await g.reserveInference(T0 + 5_000)).toEqual({ decision: "store_error" });
    },
  );

  it("Promise acceptance: consume() returns a verifiable native Promise with a fresh plain value (allowed and denied)", async () => {
    const { store } = setup();
    for (const expected of [{ allowed: true, count: 1 }, { allowed: false, count: 1 }]) {
      const ret: unknown = store.consume("k", 1, 1, EXP);
      expect(Object.getPrototypeOf(ret)).toBe(Promise.prototype);
      const F = Symbol("fallback");
      const v = await settleUntrusted<ReturnType<typeof assertConsumeResult> | typeof F>(ret, (x) => assertConsumeResult(x, 1, 1), F);
      expect(v).toEqual(expected);
    }
  });

  it("the value returned by the SDK's runTransaction is never exposed (a fresh object is built)", async () => {
    const leaked = { allowed: true, count: 1 };
    const db = { collection: () => ({ doc: (id: string) => ({ id }) }), runTransaction: async () => leaked };
    const store = new FirestoreUsageStore(async () => ({ db, Timestamp: TS }) as unknown as FirestoreDeps, () => T0);
    const r = await store.consume("k", 1, 5, EXP);
    expect(r).toEqual(leaked);
    expect(r).not.toBe(leaked);
  });
});

describe("FirestoreUsageStore (unit, fake API): negative controls", () => {
  it("an SDK layer that RE-RUNS the transaction below maxAttempts (5 attempts) applies one reservation twice → C7 detects it", async () => {
    const env = fakeApiEnv({ ignoreMaxAttemptsWith: 5 });
    env.setNow(T0);
    await expect(verifyLostCommitResponse(env, env.newStore(), "k", 1, 10, EXP)).rejects.toThrow(/increased by 2, expected exactly 1/);
    const env2 = fakeApiEnv({ ignoreMaxAttemptsWith: 5 });
    await expect(verifyGuardedLostCommit(env2)).rejects.toThrow(/increased by 2, expected exactly 1/);
  });

  it("the default (maxAttempts honoured) store applies a lost commit exactly once and surfaces unknown_outcome", async () => {
    const env = fakeApiEnv();
    env.setNow(T0);
    await expect(verifyLostCommitResponse(env, env.newStore(), "k", 1, 10, EXP)).resolves.toEqual({ rejected: true });
    expect(env.api.attempts).toBe(1);
    const { out, starts } = await verifyGuardedLostCommit(fakeApiEnv());
    expect(starts).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reserved: 0, reservationsUnknown: 1 });
    void jstDayKey;
  });
});
