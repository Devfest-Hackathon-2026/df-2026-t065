/*
 * TEST ONLY — run in a PLAIN Node child process (tests/server/usageStore/firestore.init.test.ts),
 * with Node's DEFAULT unhandled-rejection behaviour (an unhandled rejection
 * terminates the process with exit code 1). One scenario per process:
 *   node --experimental-transform-types --import ./tsRegister.mjs firestoreInit.node.ts <scenario>
 *
 * The process is NEVER ended explicitly: a scenario finishes its work AND its
 * cleanup (stores closed, servers stopped), then the event loop must drain by
 * itself. The parent kills a child that does not exit in time — that is a FAIL.
 * With OBSERVE=1 a listener only COUNTS unhandled rejections / uncaught
 * exceptions; the counts are printed on the process "exit" event, so a late
 * rejection (after RESULT) is still counted. The parent also runs every scenario
 * WITHOUT any listener and requires exit code 0 there.
 * Nothing here reaches Google Cloud: auth is a stub or fails locally, endpoints
 * are 127.0.0.1, the metadata server is never probed. Synthetic data only.
 */
import { createServer, type Server, type Socket } from "node:net";
import { handleAnalyzeMenu, type AnalyzeEnv } from "@/server/analyzeMenu";
import type { GeminiConfig } from "@/server/config";
import type { ModelCallResult } from "@/server/gemini/vertexClient";
import type { LogEvent } from "@/server/log";
import { FirestoreUsageStore, GapicFirestore, getFirestoreUsageStore, sdkConnector, type AuthLike, type TimestampClass } from "@/server/usage/firestoreStore";
import * as firestoreSdk from "@google-cloud/firestore";
import { UsageGuard, jstDayKey } from "@/server/usage/guard";
import { FakeFirestoreGrpcServer, wellFormedDoc, type ReadScript } from "../usageStore/firestoreFakes";

const counts = { unhandledRejection: 0, uncaughtException: 0 };
if (process.env.OBSERVE === "1") {
  process.on("unhandledRejection", () => void counts.unhandledRejection++);
  process.on("uncaughtException", () => void counts.uncaughtException++);
}
process.on("exit", (code) => process.stdout.write(`FINAL ${JSON.stringify({ ...counts, exitCode: code })}\n`));

const PROJECT = "demo-allergy-bridge";
const CFG: GeminiConfig = { project: PROJECT, location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const OK: ModelCallResult = {
  text: JSON.stringify({ status: "ok", imageIssues: [], items: [{ readText: "Satay with peanut sauce", readability: "clear", allergens: [{ code: "peanut", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "peanut sauce" }] }], menuNotices: [] }),
  finishReason: "STOP",
};
const ENV: AnalyzeEnv = { NODE_ENV: "development", GEMINI_ENABLED: "true", USAGE_STORE: "firestore", DAILY_INFERENCE_LIMIT: "10", GOOGLE_CLOUD_PROJECT: PROJECT };
const LIMITS = { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function request(): Request {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])], { type: "image/jpeg" }), "m.jpg");
  return new Request("http://localhost/api/analyze-menu", { method: "POST", body: f });
}

/** Calls the analyze route; returns status, error code, body text and log lines. */
async function route(store: (() => FirestoreUsageStore) | undefined, config: GeminiConfig = CFG) {
  let starts = 0;
  const logs: LogEvent[] = [];
  const res = await handleAnalyzeMenu(request(), ENV, {
    config,
    model: { generate: async () => (starts++, OK) },
    logger: (e) => void logs.push(e),
    ...(store ? { usageStores: { firestore: store } } : {}),
  });
  const body = await res.text();
  let code: string | null = null;
  try {
    code = (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    code = null;
  }
  return { status: res.status, code, body, logs: JSON.stringify(logs), starts };
}

/** A stub auth object handed to google-gax (getClient is awaited inside the GAPIC initialisation on TLS channels). */
function stubAuth(o: { failAfterMs?: number; resolveAfterMs?: number; universe?: string; universeThrows?: boolean; headersThrow?: boolean; calls?: { n: number } } = {}): AuthLike {
  const universe = o.universe ?? "googleapis.com";
  return {
    getClient: async () => {
      if (o.calls) o.calls.n++;
      if (o.failAfterMs !== undefined) {
        await sleep(o.failAfterMs);
        throw new Error("SYNTHETIC-AUTH-FAILURE /secret/path/key.json token=xyz");
      }
      if (o.resolveAfterMs) await sleep(o.resolveAfterMs);
      return {
        universeDomain: universe,
        getRequestHeaders: async () => {
          if (o.headersThrow) throw new Error("SYNTHETIC-TOKEN-FAILURE token=xyz");
          return new Headers({ authorization: "Bearer synthetic" });
        },
      };
    },
    getUniverseDomain: async () => {
      if (o.universeThrows) throw new Error("SYNTHETIC-UNIVERSE-FAILURE");
      return universe;
    },
  };
}

/** A local TCP endpoint for "TLS gRPC" that accepts and immediately closes connections (no TLS server behind it). */
async function closingEndpoint(): Promise<{ host: string; server: Server }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  return { host: `127.0.0.1:${typeof a === "object" && a ? a.port : 0}`, server };
}
const stop = (server: Server) => new Promise<void>((r) => server.close(() => r()));

const SECRET = /credential|nonexistent|GOOGLE_APPLICATION|ENOENT|secret\/path|token=|key\.json|SYNTHETIC-|universe/i;
const fakeHost = (fake: FakeFirestoreGrpcServer) => `127.0.0.1:${fake.port}`;

async function run(name: string): Promise<Record<string, unknown>> {
  switch (name) {
    // A. REST requested (FIRESTORE_PREFER_REST=true), real ADC fails — the PRODUCTION connector as is (REST is never used).
    case "A_rest_auth_failure":
    // B. Default TLS gRPC, real ADC fails — the PRODUCTION connector as is.
    case "B_grpc_auth_failure": {
      const r1 = await route(undefined); // default factory → getFirestoreUsageStore → sdkConnector(project)
      const r2 = await route(undefined); // a second request retries the initialisation
      await getFirestoreUsageStore(PROJECT).close();
      return { status: [r1.status, r2.status], code: [r1.code, r2.code], starts: r1.starts + r2.starts, leak: SECRET.test(r1.body + r2.body + r1.logs + r2.logs) };
    }
    // K. EMULATOR + REST requested, real ADC fails (audit #2): the production connector uses gRPC to the emulator host.
    case "K_emulator_rest_auth_failure": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      process.env.FIRESTORE_EMULATOR_HOST = fakeHost(fake); // set before the client is created (development/test only)
      const r = await route(undefined);
      await getFirestoreUsageStore(PROJECT).close();
      fake.stop();
      return { status: [r.status], code: [r.code], starts: r.starts, docs: fake.docs.size };
    }
    // K'. EMULATOR + REST requested, the emulator host does not answer (closed port): fail closed.
    case "K2_emulator_rest_unreachable": {
      const ep = await closingEndpoint();
      process.env.FIRESTORE_EMULATOR_HOST = ep.host;
      const r = await route(undefined, { ...CFG, requestDeadlineMs: 3000 });
      await getFirestoreUsageStore(PROJECT).close();
      await stop(ep.server);
      return { status: [r.status], code: [r.code], starts: r.starts, leak: SECRET.test(r.body + r.logs) };
    }
    // B'. TLS gRPC to a LOCAL endpoint, authentication failing (stub).
    case "B2_local_tls_auth_failure": {
      const ep = await closingEndpoint();
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ failAfterMs: 0 }), endpoint: { host: ep.host } }));
      const r = await route(() => store);
      await store.close();
      await stop(ep.server);
      return { status: [r.status], code: [r.code], starts: r.starts, leak: SECRET.test(r.body + r.logs) };
    }
    // L. The auth object is ready, then the GAPIC initialisation FAILS (createStub: universe-domain mismatch) (audit #2:
    //    a prepared GoogleAuth is NOT a successful GAPIC initialisation).
    case "L_gapic_init_failure_after_auth": {
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ universe: "example.test" }) }));
      const r = await route(() => store);
      await store.close();
      return { status: [r.status], code: [r.code], starts: r.starts, leak: SECRET.test(r.body + r.logs) };
    }
    // L3. Initialisation SUCCEEDS (getClient resolved), then the per-call credentials FAIL (token lookup throws): fail closed.
    case "L3_credentials_fail_after_init": {
      const ep = await closingEndpoint();
      const calls = { n: 0 };
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ headersThrow: true, calls }), endpoint: { host: ep.host } }));
      const r = await route(() => store, { ...CFG, requestDeadlineMs: 3000 });
      await store.close();
      await stop(ep.server);
      return { status: [r.status], code: [r.code], starts: r.starts, getClientResolved: calls.n >= 1, leak: SECRET.test(r.body + r.logs) };
    }
    // L'. Authentication succeeds, the universe-domain lookup inside the GAPIC initialisation THROWS.
    case "L2_gapic_init_throws_after_auth": {
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ universeThrows: true }) }));
      const r = await route(() => store);
      await store.close();
      return { status: [r.status], code: [r.code], starts: r.starts, leak: SECRET.test(r.body + r.logs) };
    }
    // C. Normal initialisation and a reservation (emulator mode against the local fake gRPC server).
    case "C_normal_init": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      process.env.FIRESTORE_EMULATOR_HOST = fakeHost(fake);
      const store = new FirestoreUsageStore(sdkConnector(PROJECT));
      const r = await route(() => store);
      const docs = fake.docs.size;
      const commits = fake.commitRpcs;
      await store.close();
      fake.stop();
      return { status: [r.status], code: [r.code], starts: r.starts, docs, commits };
    }
    // C'. Initialised; the SERVER refuses the commit (UNAUTHENTICATED, nothing applied): handled.
    case "C2_auth_ok_server_refuses": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      fake.inject("unauthenticated_not_applied");
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth(), endpoint: { host: fakeHost(fake), ssl: false } }));
      const r = await route(() => store);
      await store.close();
      fake.stop();
      return { status: [r.status], code: [r.code], starts: r.starts, docs: fake.docs.size, leak: SECRET.test(r.body + r.logs) };
    }
    // C3. The commit fails (ABORTED) AND the best-effort Rollback fails too: both failures are handled.
    case "C3_commit_and_rollback_fail": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      fake.inject("aborted");
      fake.failRollback = true;
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth(), endpoint: { host: fakeHost(fake), ssl: false } }));
      const r = await route(() => store);
      for (let i = 0; i < 200 && fake.rollbackRpcs < 1; i++) await sleep(10); // the rollback was sent (and failed)
      await sleep(100);
      const rollbacks = fake.rollbackRpcs;
      await store.close();
      fake.stop();
      // google-gax retries Rollback on UNAVAILABLE (safe for a rollback): the count varies, at least one was sent.
      return { status: [r.status], code: [r.code], starts: r.starts, rollbackSent: rollbacks >= 1, leak: SECRET.test(r.body + r.logs) };
    }
    // K3. Emulator mode with GOOGLE_CLOUD_UNIVERSE_DOMAIN=example.test: refused before any client is created (fail closed).
    case "K3_universe_env_refused": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      process.env.FIRESTORE_EMULATOR_HOST = fakeHost(fake);
      const r = await route(undefined);
      await getFirestoreUsageStore(PROJECT).close();
      fake.stop();
      return { status: [r.status], code: [r.code], starts: r.starts, rpcs: fake.batchGetRpcs + fake.commitRpcs, leak: SECRET.test(r.body + r.logs) };
    }
    // K4. GOOGLE_CLOUD_UNIVERSE_DOMAIN=example.test on the TLS path: refused before the client exists (the credentials are never loaded).
    case "K4_universe_env_refused_tls": {
      const ep = await closingEndpoint();
      const calls = { n: 0 };
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ calls }), endpoint: { host: ep.host } }));
      const r = await route(() => store, { ...CFG, requestDeadlineMs: 3000 });
      await store.close();
      await stop(ep.server);
      return { status: [r.status], code: [r.code], starts: r.starts, credentialsLoaded: calls.n >= 1, leak: SECRET.test(r.body + r.logs) };
    }
    // D. A failed initialisation is retried by the next call; the failed attempt sent nothing.
    case "D_retry_after_failure": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      let attempts = 0;
      const store = new FirestoreUsageStore(
        sdkConnector(PROJECT, {
          createAuth: () => {
            if (++attempts === 1) throw new Error("SYNTHETIC-INIT-FAILURE");
            return stubAuth();
          },
          endpoint: { host: fakeHost(fake), ssl: false },
        }),
      );
      const r1 = await route(() => store);
      const rpcsAfterFailure = fake.batchGetRpcs + fake.commitRpcs;
      const r2 = await route(() => store);
      await store.close();
      fake.stop();
      return { status: [r1.status, r2.status], code: [r1.code, r2.code], starts: r1.starts + r2.starts, attempts, rpcsAfterFailure, leak: SECRET.test(r1.body + r1.logs) };
    }
    // E. Concurrent requests share ONE initialisation (one client).
    case "E_shared_init": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      let creates = 0;
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => (creates++, stubAuth()), endpoint: { host: fakeHost(fake), ssl: false } }));
      const g = new UsageGuard(store, LIMITS);
      const outs = await Promise.all(Array.from({ length: 5 }, () => g.checkRate("c", Date.now() + 5000)));
      await store.close();
      fake.stop();
      return { outs, creates };
    }
    // F. The guard times out (store_timeout), THEN the authentication (inside the GAPIC initialisation) fails.
    case "F_late_auth_failure": {
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ failAfterMs: 1500 }) }));
      const g = new UsageGuard(store, LIMITS);
      const decision = await g.reserveInference(Date.now() + 500);
      const r = await route(() => store, { ...CFG, requestDeadlineMs: 1000 }); // the rate check times out → AI_DISABLED
      await store.close(); // waits for the pending initialisation (it fails at ~1.5 s), nothing to terminate
      return { decision: decision.decision, status: [r.status], code: [r.code], starts: r.starts, leak: SECRET.test(r.body + r.logs) };
    }
    // G. The call outlives the caller's deadline and fails LATER (applied commit, response lost 1.5 s late); close() waits.
    case "G_ignored_deadline_late_failure": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      fake.inject("commit_lost_late");
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth(), endpoint: { host: fakeHost(fake), ssl: false } }));
      const g = new UsageGuard(store, LIMITS);
      const decision = await g.reserveInference(Date.now() + 500);
      const t = Date.now();
      await store.close();
      const closeWaited = Date.now() - t >= 500;
      const stored = fake.docs.size;
      const commits = fake.commitRpcs;
      fake.stop();
      return { decision: decision.decision, closeWaited, stored, commits };
    }
    // H. close() while the GAPIC initialisation is still running (auth answers after 300 ms): calls fail "closed", nothing is sent.
    case "H_close_during_init": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ resolveAfterMs: 300 }), endpoint: { host: fakeHost(fake) } }));
      const reason = (e: unknown) => (e as { reason?: string }).reason ?? "rejected";
      const pending = store.consume("k", 1, 5, Date.now() + 60_000).then(() => "resolved", reason);
      await sleep(50);
      await store.close();
      const outcome = await pending;
      const after = await store.consume("k", 1, 5, Date.now() + 60_000).then(() => "resolved", reason);
      const rpcs = fake.batchGetRpcs + fake.commitRpcs;
      fake.stop();
      return { outcome, after, rpcs };
    }
    // I. Authentication OK (stub) and a TLS channel that USES it; the endpoint closes every connection: fail closed.
    case "I_auth_ok_tls_channel": {
      const ep = await closingEndpoint();
      const calls = { n: 0 };
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth({ calls }), endpoint: { host: ep.host } }));
      const r = await route(() => store, { ...CFG, requestDeadlineMs: 3000 });
      await store.close(); // waits for the failing read to settle, then closes the client
      await stop(ep.server);
      return { status: [r.status], code: [r.code], starts: r.starts, authUsed: calls.n >= 1, leak: SECRET.test(r.body + r.logs) };
    }
    // J. close() while a READ is still running (the server answers 1 s late): the transaction settles, then the client closes.
    case "J_close_during_running_read": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      fake.injectRead("read_delay_1000");
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth(), endpoint: { host: fakeHost(fake), ssl: false } }));
      const pending = store.consume("k", 1, 5, Date.now() + 60_000).then((r) => (r.allowed ? "allowed" : "denied"), (e: unknown) => (e as { reason?: string }).reason ?? "rejected");
      for (let i = 0; i < 500 && fake.batchGetRpcs < 1; i++) await sleep(10); // bounded: an init failure must not hang the scenario
      const t = Date.now();
      await store.close();
      const closeWaited = Date.now() - t >= 500;
      const outcome = await pending;
      fake.stop();
      return { outcome, closeWaited };
    }
    // M. 3rd audit MAJOR: stored 5 / limit 5, the read answers found → missing. Guard path: store_error, NO commit,
    //    stored value stays 5. Route path (the malformed answer hits the rate check): AI_DISABLED, 0 model starts.
    case "M_found_then_missing": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      const foundThenMissing: ReadScript = (c) => ({ responses: [{ found: c.found, transaction: c.tx, readTime: c.readTime }, { missing: c.name, readTime: c.readTime }] });
      const normal: ReadScript = (c) => ({ responses: [c.found ? { found: c.found, transaction: c.tx, readTime: c.readTime } : { missing: c.name, transaction: c.tx, readTime: c.readTime }] });
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth(), endpoint: { host: fakeHost(fake), ssl: false } }));
      const key = `daily:${jstDayKey(Date.now())}`;
      // Guard path: daily limit 5, stored 5.
      fake.setFields(key, wellFormedDoc(5, Date.now(), Date.now() + 3_600_000));
      fake.injectReadScript(foundThenMissing);
      const g = new UsageGuard(store, { ...LIMITS, dailyInferenceLimit: 5 });
      const decision = (await g.reserveInference(Date.now() + 5000)).decision;
      const guardCommits = fake.commitRpcs;
      const storedAfterGuard = fake.docs.get(fake.docName(key))?.fields.count;
      // Route path (DAILY_INFERENCE_LIMIT=10): the rate check reads normally, the daily read (stored 10) is malformed.
      fake.setFields(key, wellFormedDoc(10, Date.now(), Date.now() + 3_600_000));
      fake.injectReadScript(normal, foundThenMissing);
      const r = await route(() => store);
      const routeCommits = fake.commitRpcs - guardCommits; // the rate check's commit only
      const storedAfterRoute = fake.docs.get(fake.docName(key))?.fields.count;
      await store.close();
      fake.stop();
      return { decision, guardCommits, storedAfterGuard, routeCommits, storedAfterRoute, status: [r.status], code: [r.code], starts: r.starts };
    }
    // R1. Read fails after the transaction id; the best-effort Rollback FAILS LATE (0.5 s); close() waits: no unhandled rejection.
    // R2. Same, the Rollback answers after 0.8 s: close() waits for it before closing the client.
    // R3. The Rollback NEVER answers: bounded by its call timeout; close() and the process still finish.
    case "R1_rollback_fails_late":
    case "R2_close_waits_for_rollback":
    case "R3_rollback_never_answers": {
      const fake = new FakeFirestoreGrpcServer();
      await fake.start();
      if (name === "R1_rollback_fails_late") {
        fake.rollbackDelayMs = 500;
        fake.failRollback = true;
      } else if (name === "R2_close_waits_for_rollback") fake.rollbackDelayMs = 800;
      else fake.rollbackHang = true;
      fake.injectReadScript((c) => ({ responses: [{ found: c.found, transaction: c.tx, readTime: c.readTime }], thenError: true }));
      const store = new FirestoreUsageStore(sdkConnector(PROJECT, { createAuth: () => stubAuth(), endpoint: { host: fakeHost(fake), ssl: false } }));
      const outcome = await store.consume("k", 1, 5, Date.now() + 60_000).then(() => "resolved", (e: unknown) => (e as { reason?: string }).reason ?? "rejected");
      const t = Date.now();
      await store.close();
      const closeMs = Date.now() - t;
      const rollbacks = fake.rollbackRpcs;
      const commits = fake.commitRpcs;
      fake.stop();
      return { outcome, rollbacks, commits, closeWaited: closeMs >= 300, closeBounded: closeMs < 9_000 };
    }
    // R4. 4th audit MINOR-1: the GAPIC rollback THROWS SYNCHRONOUSLY after the read revealed the transaction and
    //     failed: the primary error is kept, nothing is left unhandled, close() ends (stub GAPIC client).
    case "R4_rollback_throws_synchronously": {
      const Timestamp = (firestoreSdk as unknown as { default?: { Timestamp: unknown }; Timestamp?: unknown }).default?.Timestamp ?? (firestoreSdk as unknown as { Timestamp: unknown }).Timestamp;
      let rollbacks = 0;
      const client = {
        initialize: async () => undefined,
        close: async () => undefined,
        batchGetDocuments: () =>
          (async function* () {
            yield { transaction: new Uint8Array([7]), found: null, missing: "", result: "" };
            throw Object.assign(new Error("synthetic stream failure"), { code: 14 });
          })(),
        commit: async () => [{}],
        rollback: () => {
          rollbacks++;
          throw new Error("synthetic SYNCHRONOUS rollback failure");
        },
      };
      const db = new GapicFirestore(client as unknown as ConstructorParameters<typeof GapicFirestore>[0], PROJECT, Timestamp as ConstructorParameters<typeof GapicFirestore>[2], { commitCallOptions: {} });
      const store = new FirestoreUsageStore(async () => ({ db, Timestamp: Timestamp as TimestampClass }));
      const outcome = await store.consume("k", 1, 5, Date.now() + 60_000).then(() => "resolved", (e: unknown) => (e as { reason?: string }).reason ?? "rejected");
      await store.close();
      return { outcome, rollbacks };
    }
    // N. NEGATIVE CONTROL (MINOR-1): a rejection that nobody handles, 6 s after the scenario's work is done.
    //    Under Node's default behaviour this MUST end the process with exit code 1 (and be counted with OBSERVE=1).
    case "N_negative_control_late_unhandled": {
      setTimeout(() => void Promise.reject(new Error("synthetic late unhandled rejection (negative control)")), 6000);
      return { scheduledLateRejection: true };
    }
    default:
      throw new Error(`unknown scenario ${name}`);
  }
}

const result = await run(process.argv[2] ?? "");
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
// No process.exit(): the process ends only when everything above has been cleaned up.
