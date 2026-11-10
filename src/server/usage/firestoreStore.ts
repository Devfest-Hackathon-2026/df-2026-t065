/*
 * Shared usage counters on Google Cloud Firestore (PR-F2).
 *
 * STATUS: implemented and tested against (a) a fake of the Firestore API and
 * (b) the REAL SDK's GAPIC client (@google-cloud/firestore 9.4.0 → firestore-api
 * v1, google-gax 6.16.0, gRPC) talking to a local fake gRPC server. NOT verified
 * against a real Firestore database or the Firestore emulator. `readUsageConfig`
 * therefore REFUSES this store in production (FIRESTORE_STORE_PRODUCTION_APPROVED
 * = false) — see docs/design/firestore-usage-store.md.
 *
 * Data model: collection `usageCounters`, one document per counter key:
 *   { v: 1, count: <non-negative safe integer>, expiresAt: Timestamp, deleteAfter: Timestamp }
 *  - `expiresAt` is the LOGICAL expiry (the end of the rate window / JST day).
 *    A document whose expiresAt ≤ now counts as absent (a new window).
 *  - `deleteAfter` = expiresAt + 2 days is the field a TTL policy may delete on
 *    (TTL deletion is asynchronous and never relied on for correctness).
 * Nothing else is stored: no image, menu text, AI output, allergy setting,
 * dietary profile, IP address or client identifier in clear (rate keys carry
 * the guard's hashed client key only).
 *
 * Safety conditions (S1–S5, tests/server/usageStore/contract.ts):
 *  - the check and the increment run in ONE read-write transaction: one read
 *    that starts it (BatchGetDocuments, newTransaction) and ONE Commit;
 *  - single attempt: the transaction is never re-run (the high-level SDK's
 *    runTransaction would re-run it up to 5 times by default, which can apply
 *    one logical reservation twice after a commit whose response was lost);
 *  - the Commit RPC is NOT retried by google-gax (client config AND per call;
 *    its default retries Commit on RESOURCE_EXHAUSTED / UNAVAILABLE, i.e. it
 *    re-sends a commit that may already have been applied). Verified on the
 *    real GAPIC client against a fake gRPC server; what a REAL Firestore server
 *    does with a re-sent commit, and gRPC-level transparent retries, are NOT
 *    verified (residual risk, see the design document);
 *  - the GAPIC client is initialised (awaited) before any RPC, so no
 *    initialisation failure can become an unhandled rejection (sdkConnector);
 *  - any failure is thrown (the guard fails closed: store_error, no model call;
 *    an unconfirmed reservation is counted as unknown by the runner);
 *  - stored data is never trusted: a malformed document fails the call and is
 *    never overwritten or read as 0.
 */

import type { UsageStore, ConsumeResult } from "./store";
import { UsageStoreInputError, assertConsumeArgs } from "./store";

export const USAGE_COLLECTION = "usageCounters";
export const USAGE_SCHEMA_VERSION = 1;
/** Candidate TTL retention after the logical expiry (the TTL policy itself needs separate approval). */
export const TTL_RETENTION_MS = 2 * 86_400_000;
/** Latest instant a Firestore Timestamp can hold (9999-12-31T23:59:59.999Z). */
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

/**
 * google-gax client configuration: the Commit RPC is never retried by the
 * transport layer (an empty retry-code list). Other RPCs keep their defaults
 * (reads and rollbacks are safe to retry).
 */
export const COMMIT_NO_RETRY_CLIENT_CONFIG = {
  interfaces: {
    "google.firestore.v1.Firestore": {
      retry_codes: { allergy_bridge_no_retry: [] as string[] },
      methods: { Commit: { retry_codes_name: "allergy_bridge_no_retry" } },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// The minimal Firestore surface used (the real SDK satisfies it structurally;
// tests provide fakes).
// ---------------------------------------------------------------------------

export type DocRefLike = { readonly id: string };
export type DocSnapshotLike = { readonly exists: boolean; data(): unknown };
export type TransactionLike = {
  get(ref: DocRefLike): Promise<DocSnapshotLike>;
  set(ref: DocRefLike, data: Record<string, unknown>): unknown;
};
export type FirestoreLike = {
  collection(name: string): { doc(id: string): DocRefLike };
  runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>, options: { maxAttempts: number }): Promise<T>;
  /** Releases the client's channels (the real SDK's terminate()). */
  terminate?(): Promise<void>;
};
export type TimestampLike = { toMillis(): number };
export type TimestampClass = { fromMillis(ms: number): TimestampLike; prototype: TimestampLike };
export type FirestoreDeps = { db: FirestoreLike; Timestamp: TimestampClass };

// ---------------------------------------------------------------------------
// Errors (fixed messages only: never SDK details, credentials or data)
// ---------------------------------------------------------------------------

export type FirestoreFailureReason =
  | "init_failed" // the SDK or client could not be created
  | "contention" // ABORTED: the transaction was not applied
  | "unknown_outcome" // any other failure: the commit may or may not have been applied
  | "corrupt" // the stored document is malformed (fail closed, nothing written)
  | "closed" // the store was closed (nothing sent)
  | "invalid_response"; // the server's read response is inconsistent (rejected before any commit; nothing applied)

export class FirestoreUsageStoreError extends Error {
  constructor(readonly reason: FirestoreFailureReason) {
    super(`firestore usage store: ${reason}`);
    this.name = "FirestoreUsageStoreError";
  }
}

class CorruptCounterError extends Error {}

/** A BatchGetDocuments response stream that violates the protocol (duplicates, contradictions, changed transaction…). */
export class FirestoreProtocolError extends Error {
  constructor(what: string) {
    super(`invalid read response: ${what}`);
    this.name = "FirestoreProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Keys → document IDs
// ---------------------------------------------------------------------------

/** Counter keys are printable ASCII without spaces, 1–256 characters (the guard's keys are). */
const KEY_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * Injective, Firestore-safe document ID for a counter key: "u1_" + base64url(key).
 * base64url uses only [A-Za-z0-9_-], so the ID never contains "/", is never "."
 * or "..", never matches the reserved "__.*__" form (it starts with "u1_"), and
 * is far below the 1500-byte limit. Distinct keys give distinct IDs.
 */
export function usageDocId(key: unknown): string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw new UsageStoreInputError("key");
  return `u1_${Buffer.from(key, "ascii").toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Stored document validation
// ---------------------------------------------------------------------------

type CounterState = { kind: "absent" } | { kind: "live"; count: number; expiresAtMs: number };

const DOC_KEYS = ["count", "deleteAfter", "expiresAt", "v"];

function timestampMillis(v: unknown, Timestamp: TimestampClass): number {
  if (typeof v !== "object" || v === null || !(v instanceof (Timestamp as unknown as abstract new () => object))) throw new CorruptCounterError();
  const ms = (v as TimestampLike).toMillis();
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) throw new CorruptCounterError();
  return ms;
}

/**
 * Reads a counter document strictly. Absent → "absent". Expired (expiresAt ≤ now)
 * → "absent" (a new window) — but only after the whole document validated.
 * Anything malformed throws (never 0): wrong/missing/extra fields, wrong schema
 * version, a count that is not a non-negative safe integer (NaN, ±Infinity,
 * fractional, negative, string…), timestamps of the wrong type or out of range,
 * deleteAfter ≠ expiresAt + retention, or a live expiry LATER than the caller's
 * (the guard derives the expiry deterministically from the key's window/day).
 */
function readCounter(snap: DocSnapshotLike, Timestamp: TimestampClass, nowMs: number, requestedExpiresAtMs: number): CounterState {
  if (snap.exists !== true) {
    if (snap.exists === false) return { kind: "absent" };
    throw new CorruptCounterError();
  }
  const data: unknown = snap.data();
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new CorruptCounterError();
  const proto: unknown = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) throw new CorruptCounterError();
  const keys = Object.keys(data).sort();
  if (keys.length !== DOC_KEYS.length || keys.some((k, i) => k !== DOC_KEYS[i])) throw new CorruptCounterError();
  const d = data as Record<string, unknown>;
  if (d.v !== USAGE_SCHEMA_VERSION) throw new CorruptCounterError();
  const count = d.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new CorruptCounterError();
  const expiresAtMs = timestampMillis(d.expiresAt, Timestamp);
  const deleteAfterMs = timestampMillis(d.deleteAfter, Timestamp);
  if (deleteAfterMs !== expiresAtMs + TTL_RETENTION_MS) throw new CorruptCounterError();
  if (expiresAtMs <= nowMs) return { kind: "absent" }; // expired window: starts again
  if (expiresAtMs > requestedExpiresAtMs) throw new CorruptCounterError();
  return { kind: "live", count, expiresAtMs };
}

function errorCode(e: unknown): unknown {
  try {
    return typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class FirestoreUsageStore implements UsageStore {
  readonly kind = "firestore";
  private deps: Promise<FirestoreDeps> | undefined;
  private closed = false;
  /** Transactions still running (close() waits for them before terminating the client). */
  private readonly inflight = new Set<Promise<unknown>>();

  /**
   * @param connect creates the Firestore client LAZILY, on the first valid call
   *   (never at construction, never for invalid input). A failed attempt is not
   *   cached: the next call tries again (and fails closed again if it fails).
   */
  constructor(
    private readonly connect: () => Promise<FirestoreDeps>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Closes the store: no further call reaches Firestore (new calls fail
   * "closed"), RUNNING transactions are allowed to settle, then a client that
   * was created (or was still being created) is terminated. Never rejects.
   * Waiting matters: terminating the SDK while one of its request retries is
   * still pending makes the SDK reject an internal promise nobody handles
   * (firestore 9.4.0 requestStream: `void this._clientPool.run(...)`).
   */
  async close(): Promise<void> {
    this.closed = true; // from here on, no transaction can start
    const pending = this.deps;
    this.deps = undefined;
    if (!pending) return;
    let d: FirestoreDeps;
    try {
      d = await pending;
    } catch {
      return; // initialisation failed: nothing was created
    }
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    try {
      await d.db.terminate?.();
    } catch {
      // terminate failed: nothing more to release
    }
  }

  private getDeps(): Promise<FirestoreDeps> {
    if (this.closed) return Promise.reject(new FirestoreUsageStoreError("closed"));
    if (!this.deps) {
      const p = Promise.resolve()
        .then(() => this.connect())
        .then((d) => {
          if (!d || typeof d !== "object" || !d.db || !d.Timestamp) throw new Error("invalid deps");
          return d;
        });
      this.deps = p;
      p.catch(() => {
        if (this.deps === p) this.deps = undefined;
      });
    }
    return this.deps;
  }

  async consume(key: string, amount: number, limit: number, expiresAtMs: number): Promise<ConsumeResult> {
    // Input contract first: invalid input never reaches Firestore (nor initialises it).
    const t = this.now();
    // An invalid clock would make every expiry comparison false (NaN): fail closed, touch nothing.
    if (!Number.isSafeInteger(t) || t < 0) throw new UsageStoreInputError("clock");
    assertConsumeArgs(amount, limit, expiresAtMs, t);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs + TTL_RETENTION_MS > MAX_TIMESTAMP_MS) throw new UsageStoreInputError("expiresAtMs");
    const docId = usageDocId(key);

    if (this.closed) throw new FirestoreUsageStoreError("closed");
    let deps: FirestoreDeps;
    try {
      deps = await this.getDeps();
    } catch {
      throw new FirestoreUsageStoreError(this.closed ? "closed" : "init_failed");
    }
    if (this.closed) throw new FirestoreUsageStoreError("closed"); // closed while initialising
    const { db, Timestamp } = deps;

    let result: { allowed: boolean; count: number };
    try {
      const ref = db.collection(USAGE_COLLECTION).doc(docId);
      const op = db.runTransaction(
        async (tx) => {
          const state = readCounter(await tx.get(ref), Timestamp, t, expiresAtMs);
          const base = state.kind === "live" ? state.count : 0;
          // No overflow: compare without adding (base and amount are safe integers).
          if (amount > limit - base) return { allowed: false, count: base };
          const expiry = state.kind === "live" ? state.expiresAtMs : expiresAtMs;
          const next = base + amount; // ≤ limit, a safe integer
          tx.set(ref, {
            v: USAGE_SCHEMA_VERSION,
            count: next,
            expiresAt: Timestamp.fromMillis(expiry),
            deleteAfter: Timestamp.fromMillis(expiry + TTL_RETENTION_MS),
          });
          return { allowed: true, count: next };
        },
        { maxAttempts: 1 },
      );
      this.inflight.add(op);
      try {
        result = await op;
      } finally {
        this.inflight.delete(op);
      }
    } catch (e) {
      if (e instanceof CorruptCounterError) throw new FirestoreUsageStoreError("corrupt");
      if (e instanceof FirestoreProtocolError) throw new FirestoreUsageStoreError("invalid_response");
      const code = errorCode(e);
      if (code === 10 || code === 409) throw new FirestoreUsageStoreError("contention"); // ABORTED: not applied
      throw new FirestoreUsageStoreError("unknown_outcome");
    }
    // A fresh plain object of our own (never the SDK's value).
    return { allowed: result.allowed === true, count: result.count };
  }
}

// ---------------------------------------------------------------------------
// Default (real SDK) wiring — one client per process and project.
// ---------------------------------------------------------------------------

/** Google Cloud project IDs: 6–30 characters, lowercase letters, digits and hyphens. */
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The part of a google-auth-library GoogleAuth that google-gax uses (TEST SEAM type). */
export type AuthLike = { getClient(): Promise<unknown>; getUniverseDomain(): Promise<string> };

/**
 * Test-only Firestore databases of the live harness (Issue #13 §3, G1): a database
 * dedicated to the real-environment tests, NEVER the production "(default)".
 * Only `liveTestSdkConnector` can select one; `sdkConnector` / `getFirestoreUsageStore`
 * (the production path) have no way to name a database and always use "(default)".
 */
export const LIVE_TEST_DATABASE_PATTERN = /^allergybridge-livetest(?:-[a-z0-9]{1,16})?$/;

export function isLiveTestDatabaseId(id: unknown): id is string {
  return typeof id === "string" && id !== "(default)" && LIVE_TEST_DATABASE_PATTERN.test(id);
}

export type SdkConnectorOptions = {
  /** TEST SEAM: the auth object handed to google-gax (default: google-gax's own GoogleAuth with ADC). */
  createAuth?: (o: { projectId: string }) => AuthLike;
  /** TEST SEAM: a local endpoint ("host:port"; ssl false = insecure channel). Never changes retry settings. */
  endpoint?: { host?: string; ssl?: boolean };
};

// ---------------------------------------------------------------------------
// The GAPIC adapter (PR-F2, 3rd revision)
// ---------------------------------------------------------------------------

/** The GAPIC FirestoreClient surface used (@google-cloud/firestore-api v1, reached through @google-cloud/firestore's `v1`). */
type GapicClient = {
  initialize(): Promise<unknown>;
  close(): Promise<void>;
  batchGetDocuments(request: Record<string, unknown>, options?: Record<string, unknown>): AsyncIterable<Record<string, unknown>> & NodeJS.EventEmitter;
  commit(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  rollback(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};
type TimestampCtor = TimestampClass & (new (seconds: number, nanoseconds: number) => TimestampLike & { seconds: number; nanoseconds: number });

/** Upper bound for the one BatchGetDocuments read of a transaction (single attempt). */
export const READ_TIMEOUT_MS = 10_000;

/** Upper bound for one best-effort Rollback call (close() waits for running rollbacks at most this long each). */
export const ROLLBACK_TIMEOUT_MS = 5_000;

/** A value the strict validation always refuses (an unsupported or undecodable stored value). */
const UNDECODABLE = Object.freeze({ undecodable: true });

function decodeValue(v: unknown, Timestamp: TimestampCtor): unknown {
  if (typeof v !== "object" || v === null) return UNDECODABLE;
  const o = v as Record<string, unknown>;
  const kind = typeof o.valueType === "string" ? o.valueType : Object.keys(o).find((k) => k.endsWith("Value"));
  try {
    switch (kind) {
      case "integerValue":
        return typeof o.integerValue === "string" && /^-?\d{1,20}$/.test(o.integerValue) ? Number(o.integerValue) : UNDECODABLE; // unsafe sizes fail validation later
      case "doubleValue":
        return typeof o.doubleValue === "number" ? o.doubleValue : UNDECODABLE;
      case "timestampValue": {
        const t = o.timestampValue as { seconds?: unknown; nanos?: unknown } | null;
        const seconds = Number(typeof t?.seconds === "object" && t?.seconds !== null ? String(t.seconds) : t?.seconds);
        const nanos = Number(t?.nanos ?? 0);
        return Number.isSafeInteger(seconds) && Number.isInteger(nanos) ? new Timestamp(seconds, nanos) : UNDECODABLE;
      }
      default:
        return UNDECODABLE; // strings, null, maps, arrays, … are never a valid counter field
    }
  } catch {
    return UNDECODABLE; // e.g. a Timestamp out of range
  }
}

function encodeValue(v: unknown): Record<string, unknown> {
  if (typeof v === "number" && Number.isSafeInteger(v)) return { integerValue: String(v) };
  const t = v as { seconds?: unknown; nanoseconds?: unknown };
  if (typeof v === "object" && v !== null && typeof t.seconds === "number" && typeof t.nanoseconds === "number") return { timestampValue: { seconds: String(t.seconds), nanos: t.nanoseconds } };
  throw new Error("unsupported value"); // the store only writes integers and Timestamps
}

/**
 * FirestoreLike over the GAPIC client: ONE read that starts the read-write
 * transaction (BatchGetDocuments with newTransaction), ONE Commit with the given
 * call options (no retry), best-effort Rollback after a failure. No transaction
 * runner, no request retry loop of the high-level SDK.
 */
export class GapicFirestore implements FirestoreLike {
  private readonly database: string;
  private readonly headers: Record<string, string>;
  /** Best-effort rollbacks still running: terminate() waits for them (each is bounded by its call timeout). */
  private readonly pendingRollbacks = new Set<Promise<void>>();

  constructor(
    private readonly client: GapicClient,
    projectId: string,
    private readonly Timestamp: TimestampCtor,
    private readonly opts: {
      commitCallOptions: Record<string, unknown>;
      readCallOptions?: Record<string, unknown>;
      rollbackCallOptions?: Record<string, unknown>;
      emulatorAuthHeader?: boolean;
      /** Live-test harness only (G1): a test-only database (never "(default)"); omitted = "(default)". */
      databaseId?: string;
      /** Live-test harness only (G1): a named test database is REQUIRED (no fallback to "(default)"). */
      requireLiveDatabase?: boolean;
    },
  ) {
    if (opts.requireLiveDatabase === true && opts.databaseId === undefined) throw new Error("a live-test database is required");
    if (opts.databaseId !== undefined && !isLiveTestDatabaseId(opts.databaseId)) throw new Error("only a live-test database may be named");
    this.database = `projects/${projectId}/databases/${opts.databaseId ?? "(default)"}`;
    this.headers = { "google-cloud-resource-prefix": this.database, ...(opts.emulatorAuthHeader ? { authorization: "Bearer owner" } : {}) };
  }

  collection(name: string): { doc(id: string): DocRefLike & { name: string } } {
    return { doc: (id: string) => ({ id, name: `${this.database}/documents/${name}/${id}` }) };
  }

  async terminate(): Promise<void> {
    // Wait for running rollbacks — each is bounded by its call timeout; this wait is bounded as well (own
    // timer), so close() always ends even if a transport ignored the timeout. A rollback still running
    // after that only fails against the closed client, and that failure is handled in rollback().
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = (async () => {
      while (this.pendingRollbacks.size > 0) await Promise.allSettled([...this.pendingRollbacks]);
    })();
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ROLLBACK_TIMEOUT_MS + 1_000);
    });
    try {
      await Promise.race([drained, bound]);
    } finally {
      clearTimeout(timer);
    }
    await this.client.close();
  }

  /**
   * Best effort; NEVER throws (synchronously or asynchronously), never replaces the caller's error;
   * tracked so the client is not closed under it.
   */
  private rollback(transaction: Uint8Array): void {
    let call: unknown;
    try {
      call = this.client.rollback({ database: this.database, transaction }, { ...(this.opts.rollbackCallOptions ?? {}), otherArgs: { headers: this.headers } });
    } catch {
      return; // a synchronous failure: nothing is running; the primary error is kept by the caller
    }
    const p: Promise<void> = Promise.resolve(call)
      .then(
        () => undefined,
        () => undefined, // a failed rollback only means the server will expire the transaction itself
      )
      .finally(() => void this.pendingRollbacks.delete(p));
    this.pendingRollbacks.add(p);
  }

  async runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>, options: { maxAttempts: number }): Promise<T> {
    if (options.maxAttempts !== 1) throw new Error("only single-attempt transactions are supported");
    // Set as soon as the read stream reveals it — also when the stream fails afterwards — so that a
    // started transaction is always rolled back (best effort) on failure.
    let transaction: Uint8Array | undefined;
    let reads = 0;
    const writes: Record<string, unknown>[] = [];
    const tx: TransactionLike = {
      get: async (ref) => {
        if (reads++ > 0) throw new Error("one read per transaction");
        const name = (ref as DocRefLike & { name: string }).name;
        return this.readInNewTransaction(name, (id) => void (transaction = id));
      },
      set: (ref, data) => {
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) fields[k] = encodeValue(v);
        writes.push({ update: { name: (ref as DocRefLike & { name: string }).name, fields } });
      },
    };
    try {
      const result = await fn(tx);
      if (transaction === undefined) throw new Error("no transaction was started");
      await this.client.commit({ database: this.database, writes, transaction }, { ...this.opts.commitCallOptions, otherArgs: { headers: this.headers } });
      return result;
    } catch (e) {
      if (transaction !== undefined) this.rollback(transaction);
      throw e; // the primary error, never the rollback's
    }
  }

  /**
   * ONE BatchGetDocuments for ONE document, starting the read-write transaction.
   * The response stream is validated strictly (google/firestore/v1 BatchGetDocumentsResponse):
   *  - the transaction id is set in the FIRST response (newTransaction was requested); a later response
   *    may carry no id or the SAME bytes — a different id, a missing id or a non-bytes id is refused;
   *  - exactly ONE result (found XOR missing) for exactly the requested name — a second result (found→missing,
   *    missing→found, found→found, missing→missing), another name, or found AND missing together are refused;
   *  - a response without a result is valid only when it is the first one and carries the transaction;
   *  - the document's raw field names are preserved exactly (null-prototype object: "__proto__",
   *    "constructor"… stay ordinary keys and are then refused by the strict schema check).
   * Any violation throws FirestoreProtocolError: nothing is committed (the started transaction is rolled back).
   */
  private async readInNewTransaction(name: string, onTransaction: (id: Uint8Array) => void): Promise<DocSnapshotLike> {
    const stream = this.client.batchGetDocuments({ database: this.database, documents: [name], newTransaction: { readWrite: {} } }, { ...(this.opts.readCallOptions ?? {}), otherArgs: { headers: this.headers } });
    let transaction: Uint8Array | undefined;
    let snapshot: DocSnapshotLike | undefined;
    let index = 0;
    for await (const res of stream) {
      // `for await` consumes the stream and rethrows its 'error' here.
      const first = index++ === 0;
      const id = transactionBytes(res.transaction);
      if (id !== undefined) {
        if (transaction === undefined) {
          if (!first) throw new FirestoreProtocolError("transaction id not in the first response");
          transaction = id;
          onTransaction(id);
        } else if (!sameBytes(transaction, id)) {
          throw new FirestoreProtocolError("transaction id changed");
        }
      } else if (first) {
        throw new FirestoreProtocolError("transaction id missing");
      }
      const found = res.found as { name?: unknown; fields?: unknown } | null | undefined;
      const missing = res.missing;
      const hasFound = found !== null && found !== undefined;
      const hasMissing = typeof missing === "string" ? missing !== "" : missing !== null && missing !== undefined;
      if (hasFound && hasMissing) throw new FirestoreProtocolError("found and missing together");
      const kind = hasFound ? "found" : hasMissing ? "missing" : undefined;
      if (typeof res.result === "string" && res.result !== "" && res.result !== kind) throw new FirestoreProtocolError("result kind mismatch");
      if (kind === undefined) {
        if (!(first && id !== undefined)) throw new FirestoreProtocolError("empty response");
        continue; // a transaction-only first response
      }
      if (snapshot !== undefined) throw new FirestoreProtocolError("more than one result");
      if (kind === "missing") {
        if (missing !== name) throw new FirestoreProtocolError("unexpected document");
        snapshot = { exists: false, data: () => undefined };
      } else {
        if (found!.name !== name) throw new FirestoreProtocolError("unexpected document");
        const data = this.decodeFields(found!.fields);
        snapshot = { exists: true, data: () => data };
      }
    }
    if (transaction === undefined) throw new FirestoreProtocolError("transaction id missing");
    if (snapshot === undefined) throw new FirestoreProtocolError("no result");
    return snapshot;
  }

  /** Decodes the raw fields into a NULL-PROTOTYPE object, keeping every field name exactly. */
  private decodeFields(raw: unknown): Record<string, unknown> {
    const data = Object.create(null) as Record<string, unknown>;
    if (raw === null || raw === undefined) return data; // a document without fields (refused later by the schema check)
    if (typeof raw !== "object" || Array.isArray(raw)) throw new FirestoreProtocolError("fields");
    const proto: unknown = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) throw new FirestoreProtocolError("fields prototype"); // e.g. a decoder that let "__proto__" become the prototype
    const keys = Reflect.ownKeys(raw);
    for (const k of keys) {
      if (typeof k !== "string") throw new FirestoreProtocolError("field name");
      const d = Object.getOwnPropertyDescriptor(raw, k);
      if (!d || !("value" in d)) throw new FirestoreProtocolError("field accessor");
      data[k] = decodeValue(d.value, this.Timestamp); // an own data property, also for "__proto__" (null prototype)
    }
    if (Object.keys(data).length !== keys.length) throw new FirestoreProtocolError("field names lost");
    return data;
  }
}

/** The transaction id of a response: non-empty bytes, absent (undefined), or a protocol error. */
function transactionBytes(v: unknown): Uint8Array | undefined {
  if (v === undefined || v === null) return undefined;
  if (!(v instanceof Uint8Array)) throw new FirestoreProtocolError("transaction id type");
  return v.length === 0 ? undefined : Uint8Array.prototype.slice.call(v); // a private copy
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Creates the GAPIC client and INITIALISES IT HERE, awaited and its failure
 * returned to the caller, BEFORE any RPC method is called (PR-F2 audits).
 *
 * Why: every RPC method of the GAPIC client (@google-cloud/firestore-api 0.2.0)
 * runs `this.initialize().catch((err) => { throw err; })`. If the lazy
 * initialisation (google-gax createStub: credential loading, universe-domain
 * check, client-certificate detection, stub construction, …) fails, that line
 * leaves a rejected promise nobody handles. The high-level Firestore class
 * initialises its GAPIC clients lazily inside such a method call, and gives no
 * way to await it. The GAPIC client's own `initialize()` is documented for
 * exactly this ("await on this method if you want to make sure the client is
 * initialized"): awaiting it here makes EVERY initialisation failure an ordinary
 * rejection of this promise, and after it succeeded the methods' `initialize()`
 * returns an already-resolved promise. A client whose initialisation failed is
 * never used for an RPC (only closed, its result handled).
 *
 * Transport: always gRPC (`fallback: false`): FIRESTORE_PREFER_REST is not used.
 * Universe domain: googleapis.com only (another GOOGLE_CLOUD_UNIVERSE_DOMAIN is refused; the option is pinned too).
 * FIRESTORE_EMULATOR_HOST (development/test only, see readUsageConfig): insecure
 * channel to that host, no credentials. Commit: no retry (client config AND per
 * call), so a commit whose response is lost is never re-sent by google-gax.
 */
/** module.exports of a CommonJS package loaded with import(), whatever the loader (Node ESM, Vitest, Next.js). */
function cjsExports(ns: unknown): Record<string, unknown> {
  const d = (ns as { default?: unknown }).default;
  return (typeof d === "object" || typeof d === "function") && d !== null ? (d as Record<string, unknown>) : (ns as Record<string, unknown>);
}

export function sdkConnector(projectId: string, options: SdkConnectorOptions = {}): () => Promise<FirestoreDeps> {
  return connectorFor(projectId, options, undefined);
}

/** The GAPIC client surface, for the live harness's RPC-counting wrapper (G1, tests only). */
export type LiveGapicClient = GapicClient;

export type LiveConnectorOptions = {
  /** A test-only database (`isLiveTestDatabaseId`); "(default)" is refused. */
  databaseId: string;
  /** Wraps the initialised client (RPC counting / budget). Must forward calls unchanged. */
  wrapClient?: (client: LiveGapicClient) => LiveGapicClient;
  /** L2 only: a per-call Commit deadline (1–10,000 ms). Commit still has NO retry. */
  commitTimeoutMs?: number;
};

/**
 * TEST HARNESS ONLY (Issue #13 §3, G1): the production connector's exact client
 * configuration (gRPC, googleapis.com, Commit without retry, single-attempt read,
 * bounded rollback) against a TEST-ONLY database. Refused in production, with the
 * emulator variable set, for "(default)" or any database outside the live-test pattern.
 * Nothing in the application imports it (enforced by tests).
 */
export function liveTestSdkConnector(projectId: string, live: LiveConnectorOptions, options: SdkConnectorOptions = {}): () => Promise<FirestoreDeps> {
  if (process.env.NODE_ENV === "production") throw new Error("the live-test connector is refused in production");
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new UsageStoreInputError("projectId");
  if ((process.env.FIRESTORE_EMULATOR_HOST ?? "").trim() !== "") throw new Error("the live-test connector is refused with FIRESTORE_EMULATOR_HOST set");
  // TOCTOU (PR #14 audit MAJOR-1): every option is READ EXACTLY ONCE here, validated, and only that
  // immutable copy is used later — a caller that mutates, deletes or re-defines (getter) a property
  // after this call cannot change the database the connector will use.
  const databaseId: unknown = live.databaseId;
  const wrapClient: unknown = live.wrapClient;
  const commitTimeoutMs: unknown = live.commitTimeoutMs;
  const createAuth: unknown = options.createAuth;
  const endpoint: unknown = options.endpoint;
  if (!isLiveTestDatabaseId(databaseId)) throw new Error("not a live-test database");
  if (wrapClient !== undefined && typeof wrapClient !== "function") throw new Error("invalid client wrapper");
  if (commitTimeoutMs !== undefined && (typeof commitTimeoutMs !== "number" || !Number.isSafeInteger(commitTimeoutMs) || commitTimeoutMs < 1 || commitTimeoutMs > 10_000)) throw new Error("invalid commit timeout");
  // The harness passes the credential it validated (PR #14 audit MAJOR-2): ADC is never resolved here.
  if (typeof createAuth !== "function") throw new Error("the live-test connector needs explicit credentials");
  let ep: SdkConnectorOptions["endpoint"];
  if (endpoint !== undefined) {
    const e = endpoint as { host?: unknown; ssl?: unknown };
    const host: unknown = e.host;
    const ssl: unknown = e.ssl;
    if ((host !== undefined && typeof host !== "string") || (ssl !== undefined && typeof ssl !== "boolean")) throw new Error("invalid endpoint");
    ep = Object.freeze({ ...(host !== undefined ? { host } : {}), ...(ssl !== undefined ? { ssl } : {}) });
  }
  const frozenLive: LiveConnectorOptions = Object.freeze({
    databaseId,
    ...(wrapClient !== undefined ? { wrapClient: wrapClient as NonNullable<LiveConnectorOptions["wrapClient"]> } : {}),
    ...(commitTimeoutMs !== undefined ? { commitTimeoutMs } : {}),
  });
  const frozenOptions: SdkConnectorOptions = Object.freeze({ createAuth: createAuth as NonNullable<SdkConnectorOptions["createAuth"]>, ...(ep ? { endpoint: ep } : {}) });
  return connectorFor(projectId, frozenOptions, frozenLive);
}

function connectorFor(projectId: string, options: SdkConnectorOptions, live: LiveConnectorOptions | undefined): () => Promise<FirestoreDeps> {
  return async () => {
    // Live harness: the frozen database id is re-checked at connect time (defence in depth).
    if (live && !isLiveTestDatabaseId(live.databaseId)) throw new Error("not a live-test database");
    // mTLS would make google-gax run a certificate provider command: not supported.
    if (process.env.GOOGLE_API_USE_CLIENT_CERTIFICATE === "true") throw new Error("client certificates (mTLS) are not supported");
    // GOOGLE_CLOUD_UNIVERSE_DOMAIN changes the GAPIC client's DEFAULT HOST (firestore.<universe>), i.e. where the
    // credentials would be sent: anything but googleapis.com is refused (the option below pins it as well).
    const universeEnv = (process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN ?? "").trim();
    if (universeEnv !== "" && universeEnv !== "googleapis.com") throw new Error("unsupported universe domain");
    // CommonJS packages: use module.exports (the namespace's `default`). In plain Node ESM a property
    // defined by a getter, like the SDK's `v1`, is NOT a named export of the namespace.
    const [sdkNs, gaxNs] = await Promise.all([import("@google-cloud/firestore"), import("google-gax")]);
    const sdk = cjsExports(sdkNs) as typeof sdkNs;
    const gax = cjsExports(gaxNs) as typeof gaxNs;
    const emulatorHost = (process.env.FIRESTORE_EMULATOR_HOST ?? "").trim();
    const host = emulatorHost !== "" ? emulatorHost : options.endpoint?.host;
    const insecure = emulatorHost !== "" || options.endpoint?.ssl === false;
    const hostMatch = host === undefined ? undefined : /^(.+):(\d{1,5})$/.exec(host);
    if (host !== undefined && !hostMatch) throw new Error("invalid endpoint");
    const clientOptions: Record<string, unknown> = {
      projectId,
      universeDomain: "googleapis.com",
      fallback: false,
      clientConfig: COMMIT_NO_RETRY_CLIENT_CONFIG,
      ...(hostMatch ? { servicePath: hostMatch[1], port: Number(hostMatch[2]) } : {}),
      ...(insecure ? { sslCreds: gax.grpc.credentials.createInsecure() } : {}),
      ...(options.createAuth ? { auth: options.createAuth({ projectId }) } : {}),
    };
    const v1 = (sdk as unknown as { v1: { FirestoreClient: new (o: Record<string, unknown>, g: unknown) => GapicClient } }).v1;
    const client = new v1.FirestoreClient(clientOptions, gax);
    try {
      await client.initialize(); // every initialisation failure surfaces HERE (handled by the store)
    } catch (e) {
      await client.close().catch(() => undefined); // the failed client is discarded, its close result handled
      throw e;
    }
    const noRetry = new gax.RetryOptions([], gax.createDefaultBackoffSettings());
    const rpcClient = live?.wrapClient ? live.wrapClient(client) : client;
    // Rollback: best effort, single attempt, bounded (close() waits for running rollbacks).
    const db = new GapicFirestore(rpcClient, projectId, sdk.Timestamp as unknown as TimestampCtor, {
      commitCallOptions: { retry: noRetry, ...(live?.commitTimeoutMs !== undefined ? { timeout: live.commitTimeoutMs } : {}) },
      // Read: ONE attempt, bounded. google-gax's server-streaming path re-sends a stream that failed before
      // any data through `retry-request` (default retries: 2, noResponseRetries: 2, with backoff) — not
      // controlled by `retry` — far beyond the guard's deadline, and close() would wait for it.
      readCallOptions: { retry: noRetry, retryRequestOptions: { retries: 0, noResponseRetries: 0 }, timeout: READ_TIMEOUT_MS },
      rollbackCallOptions: { retry: noRetry, timeout: ROLLBACK_TIMEOUT_MS },
      emulatorAuthHeader: insecure,
      ...(live ? { databaseId: live.databaseId, requireLiveDatabase: true } : {}),
    });
    return { db, Timestamp: sdk.Timestamp as unknown as TimestampClass };
  };
}

const processStores = new Map<string, FirestoreUsageStore>();

/** The process-wide store for `projectId` (created on first use; the client itself is created on the first consume). */
export function getFirestoreUsageStore(projectId: string): FirestoreUsageStore {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new UsageStoreInputError("projectId");
  let s = processStores.get(projectId);
  if (!s) {
    s = new FirestoreUsageStore(sdkConnector(projectId));
    processStores.set(projectId, s);
  }
  return s;
}
