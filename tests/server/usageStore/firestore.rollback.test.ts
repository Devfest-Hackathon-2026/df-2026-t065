import { Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { FirestoreUsageStore, FirestoreUsageStoreError, GapicFirestore, ROLLBACK_TIMEOUT_MS, type TimestampClass } from "@/server/usage/firestoreStore";
import { DAY } from "./firestoreFakes";

/*
 * Best-effort Rollback (PR-F2, 4th audit MINOR-1) — GapicFirestore over a STUB GAPIC
 * client (deterministic; no network). The read reveals a transaction id and then
 * fails (or is malformed); the rollback then: throws SYNCHRONOUSLY, rejects, succeeds,
 * answers late, or never answers. The primary error must be kept, nothing may be
 * left unhandled (Vitest fails the run on any unhandled rejection), no commit is
 * sent, and close() must wait for a running rollback but stay bounded.
 */

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const EXP = T0 + DAY;
const TS = Timestamp as unknown as TimestampClass;
type RollbackMode = "sync_throw" | "reject" | "ok" | "delay_800" | "never";
type ReadMode = "tx_then_stream_error" | "tx_then_duplicate";

const STREAM_ERROR_MESSAGE = "synthetic stream failure";

function stub(rollbackMode: RollbackMode, readMode: ReadMode = "tx_then_stream_error") {
  const calls = { rollback: 0, commit: 0, closed: 0, rollbackSettled: 0 };
  const name = "projects/demo-allergy-bridge/databases/(default)/documents/usageCounters/u1_aw";
  const client = {
    initialize: async () => undefined,
    close: async () => void calls.closed++,
    batchGetDocuments: () =>
      (async function* () {
        yield { transaction: new Uint8Array([1, 2, 3]), found: null, missing: "", result: "" }; // transaction-only first response (valid)
        if (readMode === "tx_then_duplicate") {
          yield { transaction: new Uint8Array(0), found: null, missing: name, result: "missing" };
          yield { transaction: new Uint8Array(0), found: null, missing: name, result: "missing" }; // a second result
          return;
        }
        throw Object.assign(new Error(STREAM_ERROR_MESSAGE), { code: 14 });
      })(),
    commit: async () => {
      calls.commit++;
      return [{}];
    },
    rollback: () => {
      calls.rollback++;
      switch (rollbackMode) {
        case "sync_throw":
          throw new Error("synthetic SYNCHRONOUS rollback failure");
        case "reject":
          return Promise.reject(new Error("synthetic rollback rejection"));
        case "ok":
          return Promise.resolve([{}]).finally(() => void calls.rollbackSettled++);
        case "delay_800":
          return new Promise((r) => setTimeout(() => r([{}]), 800)).finally(() => void calls.rollbackSettled++);
        case "never":
          return new Promise(() => undefined);
      }
    },
  };
  const db = new GapicFirestore(client as unknown as ConstructorParameters<typeof GapicFirestore>[0], "demo-allergy-bridge", Timestamp as unknown as ConstructorParameters<typeof GapicFirestore>[2], { commitCallOptions: {} });
  const store = new FirestoreUsageStore(async () => ({ db, Timestamp: TS }), () => T0);
  return { store, calls, db };
}
const reasonOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof FirestoreUsageStoreError ? e.reason : `other:${String(e)}`));
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("best-effort Rollback never replaces the primary error and never stays unhandled (stub GAPIC client)", () => {
  it.each([
    ["1 the rollback throws SYNCHRONOUSLY", "sync_throw"],
    ["2 the rollback REJECTS", "reject"],
    ["3 the rollback succeeds", "ok"],
  ] as const)("%s → the primary error (unknown_outcome) is kept, 1 rollback attempt, 0 commits, close() ends", async (_n, mode) => {
    const { store, calls } = stub(mode);
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    await tick();
    expect(calls.rollback).toBe(1);
    expect(calls.commit).toBe(0);
    await store.close();
    expect(calls.closed).toBe(1);
  });

  it.each(["sync_throw", "reject", "ok"] as const)("6 at the adapter level, rollback %s: runTransaction rejects with the ORIGINAL read error object (code 14), never the rollback's", async (mode) => {
    const { db, calls } = stub(mode);
    const ref = db.collection("usageCounters").doc("u1_aw");
    const err = await db.runTransaction(async (tx) => tx.get(ref), { maxAttempts: 1 }).then(() => null, (e: unknown) => e as { message?: string; code?: unknown });
    expect(err?.message).toBe(STREAM_ERROR_MESSAGE);
    expect(err?.code).toBe(14);
    await tick();
    expect(calls.rollback).toBe(1);
    await db.terminate();
  });

  it.each(["sync_throw", "reject"] as const)("6 a malformed read (duplicate result) + rollback %s → the primary reason invalid_response is kept", async (mode) => {
    const { store, calls } = stub(mode, "tx_then_duplicate");
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("invalid_response");
    await tick();
    expect(calls.rollback).toBe(1);
    expect(calls.commit).toBe(0);
    await store.close();
  });

  it("4 a rollback answering after 0.8 s: close() WAITS for it, then closes the client", async () => {
    const { store, calls } = stub("delay_800");
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    const t = Date.now();
    await store.close();
    expect(Date.now() - t).toBeGreaterThanOrEqual(600);
    expect(calls.rollbackSettled).toBe(1); // settled BEFORE the client was closed
    expect(calls.closed).toBe(1);
  });

  it(`5 a rollback that NEVER settles (even ignoring its call timeout): close() is bounded (≈ ${ROLLBACK_TIMEOUT_MS + 1000} ms) and closes the client`, async () => {
    const { store, calls } = stub("never");
    expect(await reasonOf(store.consume("k", 1, 5, EXP))).toBe("unknown_outcome");
    const outcome = await Promise.race([store.close().then(() => "closed"), new Promise((r) => setTimeout(() => r("still waiting"), ROLLBACK_TIMEOUT_MS + 3_000))]);
    expect(outcome).toBe("closed");
    expect(calls.closed).toBe(1);
  }, 20_000);
});
