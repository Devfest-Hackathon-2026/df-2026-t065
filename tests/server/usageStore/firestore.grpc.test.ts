import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FirestoreUsageStore, FirestoreUsageStoreError, sdkConnector } from "@/server/usage/firestoreStore";
import { describeSharedUsageStoreContract, storedUnits } from "./contract";
import { DAY, FakeFirestoreGrpcServer, grpcEnv, wellFormedDoc, type GrpcMode } from "./firestoreFakes";

/*
 * FirestoreUsageStore with the REAL @google-cloud/firestore 9.4.0 SDK (google-gax,
 * gRPC transport, value encoding, transaction handling) against a LOCAL FAKE
 * Firestore gRPC server on 127.0.0.1 (TEST ONLY — NOT Firestore, NOT the emulator).
 * No Google Cloud access: insecure local channel, no credentials, no metadata server.
 *
 * What this verifies on the SDK: the store's transactions use one attempt, the
 * Commit RPC is not re-sent by google-gax after a lost response, ABORTED is not
 * retried, and the documents the SDK writes/reads have the expected types.
 * What it CANNOT verify: a real server's locking, contention rate and behaviour
 * for a re-sent commit, gRPC transparent retries on a real network, TTL, IAM.
 */

process.env.METADATA_SERVER_DETECTION = "none"; // never probe the GCE metadata server from tests

const server = new FakeFirestoreGrpcServer();
const stores: FirestoreUsageStore[] = [];
beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await Promise.all(stores.map((s) => s.close())); // close() waits for running transactions, never rejects
  server.stop();
});

describeSharedUsageStoreContract(() => grpcEnv(server, stores));

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const EXP = T0 + DAY;

function setup(mode: GrpcMode = "production") {
  const env = grpcEnv(server, stores, mode);
  env.setNow(T0);
  return { env, store: env.newStore() };
}
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as FirestoreUsageStoreError);

describe("FirestoreUsageStore × real SDK × fake gRPC server: retry behaviour of the SDK layers", () => {
  it("normal path: ONE transaction read and ONE commit per consume; the stored document has the expected wire types", async () => {
    const { store } = setup();
    expect(await store.consume("daily:2026-11-07", 1, 5, EXP)).toEqual({ allowed: true, count: 1 });
    expect(server.batchGetRpcs).toBe(1);
    expect(server.commitRpcs).toBe(1);
    const d = server.docs.get(server.docName("daily:2026-11-07"))!;
    expect(Object.keys(d.fields).sort()).toEqual(["count", "deleteAfter", "expiresAt", "v"]);
    expect(d.fields.count).toEqual({ integerValue: "1" });
    expect(d.fields.v).toEqual({ integerValue: "1" });
    expect(d.fields.expiresAt).toHaveProperty("timestampValue");
    expect(d.fields.deleteAfter).toHaveProperty("timestampValue");
    expect(await store.consume("daily:2026-11-07", 1, 5, EXP)).toEqual({ allowed: true, count: 2 }); // read back through the SDK
  });

  it("S1 on the SDK: a commit APPLIED and then its response lost (UNAVAILABLE) is sent ONCE — not re-sent by google-gax, not re-run by runTransaction", async () => {
    const { env, store } = setup();
    server.inject("commit_lost");
    const err = await failure(store.consume("k", 1, 5, EXP));
    expect(err).toBeInstanceOf(FirestoreUsageStoreError);
    expect(err!.reason).toBe("unknown_outcome");
    expect(server.commitRpcs).toBe(1);
    expect(server.commitsPerTx).toEqual([1]);
    expect(server.batchGetRpcs).toBe(1); // the transaction was not re-run
    expect(storedUnits(env.backend.observe("k"), { mustExist: true })).toBe(1); // applied exactly once (S2: counted as unknown by the guard)
  });

  it("NEGATIVE CONTROL — SDK defaults (no clientConfig override): the SAME commit is re-sent by google-gax after the lost response (the risk the override removes)", async () => {
    const { store } = setup("sdk_default_retry");
    server.inject("commit_lost");
    await failure(store.consume("k", 1, 5, EXP));
    expect(server.commitRpcs).toBe(2);
    expect(server.commitsPerTx).toEqual([1, 2]); // a second Commit for the same transaction id
    // This fake refuses the re-sent commit (transaction finished). What a REAL server does with it is NOT verified.
  });

  it.each([
    ["UNAVAILABLE (not applied)", "unavailable_not_applied" as const],
    ["RESOURCE_EXHAUSTED (not applied)", "resource_exhausted_not_applied" as const],
  ])("a commit failing with %s is NOT retried with the override (1 commit), but IS with the SDK defaults (2 commits)", async (_n, fault) => {
    const a = setup();
    server.inject(fault);
    expect((await failure(a.store.consume("k", 1, 5, EXP)))!.reason).toBe("unknown_outcome");
    expect(server.commitRpcs).toBe(1);
    const b = setup("sdk_default_retry");
    server.inject(fault);
    await failure(b.store.consume("k", 1, 5, EXP));
    expect(server.commitRpcs).toBe(2);
  });

  it("ABORTED is surfaced as contention: one transaction attempt (maxAttempts 1), one commit, nothing applied", async () => {
    const { env, store } = setup();
    server.inject("aborted");
    expect((await failure(store.consume("k", 1, 5, EXP)))!.reason).toBe("contention");
    expect(server.batchGetRpcs).toBe(1);
    expect(server.commitRpcs).toBe(1);
    expect(env.backend.observe("k")).toEqual({ exists: false });
  });

  it("the client is created lazily: constructing the store sends nothing; invalid input sends nothing", async () => {
    const { store } = setup();
    await expect(store.consume("bad key", 1, 5, EXP)).rejects.toThrow();
    await expect(store.consume("k", 0, 5, EXP)).rejects.toThrow();
    expect(server.batchGetRpcs + server.commitRpcs).toBe(0);
  });
});

describe("FirestoreUsageStore × real SDK × fake gRPC server: stored value types as DECODED by the SDK", () => {
  it.each([
    ["doubleValue NaN", Number.NaN],
    ["doubleValue Infinity", Number.POSITIVE_INFINITY],
    ["doubleValue 1.5", 1.5],
    ["negative integer", -1],
    ["stringValue", "1"],
    ["nullValue", null],
    ["mapValue", { n: 1 }],
  ])("count stored as %s → corrupt (fail closed), nothing written", async (_n, raw) => {
    const { env, store } = setup();
    env.backend.setRaw("k", raw);
    const before = server.docs.get(server.docName("k"));
    expect((await failure(store.consume("k", 1, 10, EXP)))!.reason).toBe("corrupt");
    expect(server.docs.get(server.docName("k"))).toBe(before);
  });

  it("an integer-valued doubleValue (3.0) decodes to the number 3 and is accepted as 3 (documented: the SDK does not distinguish)", async () => {
    const { store } = setup();
    server.setFields("k", wellFormedDoc(3, T0));
    server.docs.get(server.docName("k"))!.fields.count = { doubleValue: 3 };
    expect(await store.consume("k", 1, 10, EXP)).toEqual({ allowed: true, count: 4 });
    expect(server.docs.get(server.docName("k"))!.fields.count).toEqual({ integerValue: "4" }); // rewritten as an integer
  });
});

describe("the PRODUCTION connector (sdkConnector) × real SDK × fake gRPC server", () => {
  it("creates its client lazily with the Commit no-retry override, database (default) and the given project: a lost commit is sent ONCE", async () => {
    grpcEnv(server, stores); // reset the server state
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", `127.0.0.1:${server.port}`); // the SDK honours it over any setting (test only)
    try {
      let created = 0;
      const connect = sdkConnector("demo-allergy-bridge");
      const store = new FirestoreUsageStore(async () => {
        const d = await connect();
        created++;
        return d;
      }, () => T0);
      stores.push(store);
      expect(created).toBe(0); // nothing created at construction
      expect(await store.consume("k", 1, 5, EXP)).toEqual({ allowed: true, count: 1 });
      const name = "projects/demo-allergy-bridge/databases/(default)/documents/usageCounters/";
      expect([...server.docs.keys()].every((k) => k.startsWith(name))).toBe(true);
      server.inject("commit_lost");
      expect((await failure(store.consume("k", 1, 5, EXP)))!.reason).toBe("unknown_outcome");
      expect(server.commitRpcs).toBe(2); // one per consume: the lost one was NOT re-sent
      expect(server.commitsPerTx).toEqual([1, 1]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("sdkConnector: unsupported authentication modes are refused BEFORE the SDK is created", () => {
  it("GOOGLE_API_USE_CLIENT_CERTIFICATE=true (mTLS: google-gax would run a certificate provider inside its unhandled initialisation) → init_failed, auth never created", async () => {
    vi.stubEnv("GOOGLE_API_USE_CLIENT_CERTIFICATE", "true");
    try {
      let authCreated = 0;
      const store = new FirestoreUsageStore(sdkConnector("demo-allergy-bridge", { createAuth: () => (authCreated++, { getClient: async () => ({}), getUniverseDomain: async () => "googleapis.com" }) }), () => T0);
      expect((await failure(store.consume("k", 1, 5, EXP)))!.reason).toBe("init_failed");
      expect(authCreated).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a universe domain other than googleapis.com → init_failed (google-gax would throw inside its unhandled initialisation)", async () => {
    const store = new FirestoreUsageStore(sdkConnector("demo-allergy-bridge", { createAuth: () => ({ getClient: async () => ({}), getUniverseDomain: async () => "example.test" }) }), () => T0);
    expect((await failure(store.consume("k", 1, 5, EXP)))!.reason).toBe("init_failed");
  });
});

describe("google-gax used by the connector is the SDK's own instance", () => {
  it("import(\"google-gax\") resolves to the very module @google-cloud/firestore loads (same GoogleAuth class)", async () => {
    const { createRequire } = await import("node:module");
    const fromSdk = createRequire(createRequire(import.meta.url).resolve("@google-cloud/firestore"))("google-gax") as { GoogleAuth: unknown };
    const fromApp = (await import("google-gax")) as unknown as { GoogleAuth: unknown };
    expect(fromApp.GoogleAuth).toBe(fromSdk.GoogleAuth);
  });
});
