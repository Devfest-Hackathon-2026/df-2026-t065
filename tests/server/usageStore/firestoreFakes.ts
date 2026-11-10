import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as firestoreSdk from "@google-cloud/firestore";
import { Timestamp } from "@google-cloud/firestore";
import * as gax from "google-gax";
import { grpc, protobuf } from "google-gax";
import {
  FirestoreUsageStore,
  GapicFirestore,
  sdkConnector,
  FirestoreUsageStoreError,
  TTL_RETENTION_MS,
  USAGE_COLLECTION,
  USAGE_SCHEMA_VERSION,
  type DocRefLike,
  type FirestoreDeps,
  type FirestoreLike,
  type TimestampClass,
  type TransactionLike,
} from "@/server/usage/firestoreStore";
import type { CounterObservation, SharedStoreEnv } from "./contract";
import type { BackendFault } from "./referenceTransactionalStore";

/*
 * TEST ONLY — two backends for the Firestore usage store. NEITHER IS FIRESTORE.
 *
 *  1. FakeFirestoreApi: a fake of the small Firestore API surface the store uses
 *     (collection/doc/runTransaction/get/set). Pure unit tests, no SDK code runs.
 *  2. FakeFirestoreGrpcServer: a local gRPC server speaking the Firestore v1 wire
 *     protocol (BatchGetDocuments / Commit / Rollback / BeginTransaction), so the
 *     REAL @google-cloud/firestore 9.4.0 SDK (google-gax, gRPC transport, value
 *     encoding, transaction handling, retry configuration) runs end to end.
 *     Its concurrency control is OPTIMISTIC (a transaction aborts if a document it
 *     read changed before its commit); a real Firestore server uses its own
 *     locking — not modelled. A re-sent commit of a finished transaction is
 *     refused here; what a real server does is NOT verified.
 * Both use synthetic data only.
 */

export const DAY = 86_400_000;
const docIdToKey = (id: string): string => Buffer.from(id.slice(3), "base64url").toString("ascii");
const keyToDocId = (key: string): string => `u1_${Buffer.from(key, "ascii").toString("base64url")}`;
const TS = Timestamp as unknown as TimestampClass;

/** A well-formed document holding `count` (any raw value, to model corruption), valid for 60 s. */
export function wellFormedDoc(count: unknown, nowMs: number, expiresAtMs = nowMs + 60_000): Record<string, unknown> {
  return { v: USAGE_SCHEMA_VERSION, count, expiresAt: Timestamp.fromMillis(expiresAtMs), deleteAfter: Timestamp.fromMillis(expiresAtMs + TTL_RETENTION_MS) };
}

export function sdkLikeError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const RETRYABLE = new Set([1, 2, 4, 8, 10, 13, 14, 16]); // the SDK's transaction retry codes (isRetryableTransactionError)

// ---------------------------------------------------------------------------
// 1. Fake of the Firestore API
// ---------------------------------------------------------------------------

type FakeDoc = { data: unknown; version: number };

export class FakeFirestoreApi implements FirestoreLike {
  readonly docs = new Map<string, FakeDoc>(); // path → document
  private readonly faults: BackendFault[] = [];
  private clock = 0;
  /** Every options object passed to runTransaction (to check maxAttempts: 1). */
  readonly transactionOptions: unknown[] = [];
  attempts = 0;
  commits = 0;
  appliedCommits = 0;
  /**
   * NEGATIVE CONTROL: re-run the whole transaction up to N times on a retryable
   * error, IGNORING the maxAttempts option (models an SDK layer that retries
   * below the option the store set).
   */
  ignoreMaxAttemptsWith: number | undefined;

  inject(...f: BackendFault[]): void {
    this.faults.push(...f);
  }
  setDoc(path: string, data: unknown): void {
    this.docs.set(path, { data, version: ++this.clock });
  }
  removeDoc(path: string): void {
    this.docs.delete(path);
  }

  collection(name: string): { doc(id: string): DocRefLike & { path: string } } {
    return { doc: (id: string) => ({ id, path: `${name}/${id}` }) };
  }

  async runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>, options: { maxAttempts: number }): Promise<T> {
    this.transactionOptions.push(options);
    const max = this.ignoreMaxAttemptsWith ?? options.maxAttempts;
    let last: unknown;
    for (let i = 0; i < max; i++) {
      try {
        return await this.attempt(fn);
      } catch (e) {
        last = e;
        const code = (e as { code?: unknown }).code;
        if (typeof code !== "number" || !RETRYABLE.has(code)) break;
      }
    }
    throw last;
  }

  private async attempt<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T> {
    this.attempts++;
    const reads = new Map<string, number>();
    const writes = new Map<string, Record<string, unknown>>();
    const path = (ref: DocRefLike) => (ref as DocRefLike & { path: string }).path;
    const tx: TransactionLike = {
      get: async (ref) => {
        await Promise.resolve(); // a network round trip
        const d = this.docs.get(path(ref));
        reads.set(path(ref), d?.version ?? 0);
        return { exists: d !== undefined, data: () => (d === undefined ? undefined : d.data) };
      },
      set: (ref, data) => void writes.set(path(ref), data),
    };
    const result = await fn(tx);
    await Promise.resolve(); // the commit round trip
    this.commits++;
    const fault = this.faults.shift();
    if (fault === "aborted") throw sdkLikeError(10, "synthetic ABORTED (nothing applied)");
    for (const [p, v] of reads) if ((this.docs.get(p)?.version ?? 0) !== v) throw sdkLikeError(10, "synthetic conflict ABORTED");
    for (const [p, data] of writes) this.docs.set(p, { data, version: ++this.clock });
    if (writes.size > 0) this.appliedCommits++;
    if (fault === "commit_lost") throw sdkLikeError(4, "synthetic: applied, response lost");
    return result;
  }
}

// ---------------------------------------------------------------------------
// 2. Fake Firestore gRPC server (the real SDK talks to it)
// ---------------------------------------------------------------------------

type ProtoValue = Record<string, unknown>;
type ServerDoc = { fields: Record<string, ProtoValue>; version: number };
type ServerTx = { reads: Map<string, number>; finished: boolean; commits: number };
export type GrpcFault =
  | BackendFault
  | "unavailable_not_applied"
  | "resource_exhausted_not_applied"
  | "unauthenticated_not_applied" // the server refuses the commit's credentials (nothing applied)
  | "commit_lost_late"; // applied, then UNAVAILABLE 1.5 s later (a response that arrives after the caller gave up)
/** Fault of the NEXT BatchGetDocuments call: UNAVAILABLE, or a normal answer delayed by 1 s (a read still running). */
export type ReadFault = "read_unavailable" | "read_permission_denied" | "read_delay_1000" | "read_hang";

/**
 * A SCRIPTED answer for the NEXT BatchGetDocuments call (malformed-response tests). `tx` is the id of the
 * transaction the server started (base64), `otherTx` another valid-looking id, `found` the stored document
 * as a `found` payload (undefined if absent). After writing `responses`, the stream ends — or fails with
 * UNAVAILABLE when `thenError` is set.
 */
export type ReadScript = (c: { name: string; tx: string; otherTx: string; found: ProtoValue | undefined; readTime: ProtoValue }) => { responses: ProtoValue[]; thenError?: boolean };

const req = createRequire(import.meta.url);
const protosJson = JSON.parse(readFileSync(req.resolve("@google-cloud/firestore-api/build/protos/protos.json"), "utf8")) as protobuf.INamespace;

export function encodeValue(v: unknown): ProtoValue {
  if (v instanceof Timestamp) return { timestampValue: { seconds: String(v.seconds), nanos: v.nanoseconds } };
  if (v === null) return { nullValue: "NULL_VALUE" };
  if (typeof v === "number") return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, encodeValue(x)])) } };
  throw new Error("unsupported synthetic value");
}

/** Decodes a stored proto value to a raw JS value (numbers as numbers; anything else as a tagged object). */
export function decodeValue(v: ProtoValue | undefined): unknown {
  if (v === undefined) return undefined;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue === "NaN" ? Number.NaN : v.doubleValue === "Infinity" ? Number.POSITIVE_INFINITY : v.doubleValue === "-Infinity" ? Number.NEGATIVE_INFINITY : Number(v.doubleValue);
  return `\u0000non-numeric:${JSON.stringify(v)}`; // a primitive tag: unchanged values compare equal (Object.is)
}

export class FakeFirestoreGrpcServer {
  readonly docs = new Map<string, ServerDoc>(); // full document name → fields
  private readonly txs = new Map<string, ServerTx>();
  private faults: GrpcFault[] = [];
  private readFaults: ReadFault[] = [];
  private readScripts: ReadScript[] = [];
  private clock = 0;
  private txSeq = 0;
  private server: grpc.Server | undefined;
  port = 0;
  commitRpcs = 0;
  batchGetRpcs = 0;
  rollbackRpcs = 0;
  /** When true, every Rollback fails (UNAVAILABLE). */
  failRollback = false;
  /** Rollback answers (or fails) only after this delay. */
  rollbackDelayMs = 0;
  /** Rollback never answers (the client must give up by its own call timeout). */
  rollbackHang = false;
  /** Transaction ids received by Rollback, in order (base64). */
  readonly rollbackTxs: string[] = [];
  /** Commit RPCs per transaction id (a value > 1 means the SDK re-sent a commit). */
  readonly commitsPerTx: number[] = [];
  /** Admin RPCs (live harness, G1): ListDocuments / ListCollectionIds / GetDocument / DeleteDocument received. */
  readonly adminRpcs = { listDocuments: 0, listCollectionIds: 0, getDocument: 0, deleteDocument: 0 };
  /** Fault of the NEXT admin RPC: UNAVAILABLE, or never answer. */
  adminFaults: ("unavailable" | "hang")[] = [];
  /** ListDocuments / ListCollectionIds: answer this many EMPTY pages (with a continuation token) before the real ones. */
  emptyPagesBefore = 0;
  /**
   * G1 L4 (live run 2026-11-09): protobuf leaves the wire order of map entries (Document.fields) UNSPECIFIED, so a real
   * server may answer two reads of the SAME unchanged document with the fields in a different order. When true, every
   * second document returned by each read method (GetDocument, BatchGetDocuments: counted separately) carries its
   * fields in reverse order. Values are unchanged.
   */
  reorderFieldsOnRead = false;
  /** WriteResult permits a no-op write to retain the previous update_time. Opt-in; never hides a received Commit. */
  preserveUpdateTimeOnNoop = false;
  private readonly documentsServed = { getDocument: 0, batchGet: 0 };

  reset(): void {
    this.docs.clear();
    this.txs.clear();
    this.faults = [];
    this.readFaults = [];
    this.readScripts = [];
    this.rollbackDelayMs = 0;
    this.rollbackHang = false;
    this.commitRpcs = this.batchGetRpcs = this.rollbackRpcs = 0;
    this.failRollback = false;
    this.commitsPerTx.length = 0;
    this.rollbackTxs.length = 0;
    for (const k of Object.keys(this.adminRpcs) as (keyof FakeFirestoreGrpcServer["adminRpcs"])[]) this.adminRpcs[k] = 0;
    this.adminFaults = [];
    this.emptyPagesBefore = 0;
    this.reorderFieldsOnRead = false;
    this.preserveUpdateTimeOnNoop = false;
    this.documentsServed.getDocument = this.documentsServed.batchGet = 0;
  }

  /** The stored fields as sent on the wire: as stored, or (reorderFieldsOnRead) reversed on every second document served. */
  private wireFields(fields: Record<string, ProtoValue>, method: "getDocument" | "batchGet"): Record<string, ProtoValue> {
    if (!this.reorderFieldsOnRead || this.documentsServed[method]++ % 2 === 0) return fields;
    return Object.fromEntries(Object.entries(fields).reverse());
  }

  /** Total RPCs the server RECEIVED (what the clients actually sent). */
  get totalRpcs(): number {
    const a = this.adminRpcs;
    return this.batchGetRpcs + this.commitRpcs + this.rollbackRpcs + a.listDocuments + a.listCollectionIds + a.getDocument + a.deleteDocument;
  }
  inject(...f: GrpcFault[]): void {
    this.faults.push(...f);
  }
  injectRead(...f: ReadFault[]): void {
    this.readFaults.push(...f);
  }
  injectReadScript(...f: ReadScript[]): void {
    this.readScripts.push(...f);
  }
  docName(key: string): string {
    return `projects/demo-allergy-bridge/databases/(default)/documents/${USAGE_COLLECTION}/${keyToDocId(key)}`;
  }
  setFields(key: string, data: Record<string, unknown>): void {
    this.docs.set(this.docName(key), { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encodeValue(v)])), version: ++this.clock });
  }

  async start(): Promise<void> {
    const root = protobuf.Root.fromJSON(protosJson);
    const svc = root.lookupService("google.firestore.v1.Firestore");
    const def = (name: string, responseStream: boolean): grpc.MethodDefinition<ProtoValue, ProtoValue> => {
      const m = svc.methods[name]!;
      m.resolve();
      const reqT = m.resolvedRequestType!;
      const resT = m.resolvedResponseType!;
      return {
        path: `/google.firestore.v1.Firestore/${name}`,
        requestStream: false,
        responseStream,
        requestSerialize: (v) => Buffer.from(reqT.encode(reqT.fromObject(v)).finish()),
        requestDeserialize: (b) => reqT.toObject(reqT.decode(b), { longs: String, bytes: String, defaults: false, oneofs: false }) as ProtoValue,
        responseSerialize: (v) => Buffer.from(resT.encode(resT.fromObject(v)).finish()),
        responseDeserialize: (b) => resT.toObject(resT.decode(b)) as ProtoValue,
      };
    };
    const ts = (n: number) => ({ seconds: String(1_700_000_000 + n), nanos: 0 });
    const server = new grpc.Server();
    server.addService(
      {
        BatchGetDocuments: def("BatchGetDocuments", true),
        Commit: def("Commit", false),
        Rollback: def("Rollback", false),
        BeginTransaction: def("BeginTransaction", false),
        ListDocuments: def("ListDocuments", false),
        ListCollectionIds: def("ListCollectionIds", false),
        GetDocument: def("GetDocument", false),
        DeleteDocument: def("DeleteDocument", false),
      },
      {
        // ---- admin RPCs of the live harness (G1): real protocol semantics as far as the harness relies on them ----
        ListDocuments: (call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          this.adminRpcs.listDocuments++;
          if (this.adminFault(cb)) return;
          const r = call.request;
          const prefix = `${String(r.parent)}/${String(r.collectionId)}/`;
          const present = new Set<string>();
          const missing = new Set<string>();
          for (const name of this.docs.keys()) {
            if (!name.startsWith(prefix)) continue;
            const rest = name.slice(prefix.length);
            const id = rest.split("/")[0]!;
            if (!rest.includes("/")) present.add(`${prefix}${id}`);
            else missing.add(`${prefix}${id}`); // a document below a parent that may not exist itself
          }
          const names = [...present, ...(r.showMissing === true ? [...missing].filter((n) => !present.has(n)) : [])].sort();
          this.page(r, names, (n) => (present.has(n) ? { name: n, fields: {}, createTime: ts(1), updateTime: ts(1) } : { name: n }), "documents", cb);
        },
        ListCollectionIds: (call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          this.adminRpcs.listCollectionIds++;
          if (this.adminFault(cb)) return;
          const r = call.request;
          const prefix = `${String(r.parent)}/`;
          const ids = [...new Set([...this.docs.keys()].filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length).split("/")[0]!))].sort();
          this.page(r, ids, (x) => x, "collectionIds", cb);
        },
        GetDocument: (call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          this.adminRpcs.getDocument++;
          if (this.adminFault(cb)) return;
          const name = String(call.request.name);
          const d = this.docs.get(name);
          if (!d) return cb({ code: grpc.status.NOT_FOUND, details: "synthetic NOT_FOUND" });
          cb(null, { name, fields: this.wireFields(d.fields, "getDocument"), createTime: ts(d.version), updateTime: ts(d.version) });
        },
        DeleteDocument: (call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          this.adminRpcs.deleteDocument++;
          if (this.adminFault(cb)) return;
          this.docs.delete(String(call.request.name));
          cb(null, {});
        },
        BatchGetDocuments: (call: grpc.ServerWritableStream<ProtoValue, ProtoValue>) => {
          this.batchGetRpcs++;
          const readFault = this.readFaults.shift();
          if (readFault === "read_unavailable") return void call.emit("error", { code: grpc.status.UNAVAILABLE, details: "synthetic UNAVAILABLE" }); // grpc-js sends this status
          if (readFault === "read_permission_denied") return void call.emit("error", { code: grpc.status.PERMISSION_DENIED, details: "synthetic PERMISSION_DENIED" }); // not retried by google-gax
          const r = call.request;
          let txId: string | undefined;
          if (r.newTransaction) {
            txId = Buffer.from(`tx-${++this.txSeq}`).toString("base64");
            this.txs.set(txId, { reads: new Map(), finished: false, commits: 0 });
          } else if (typeof r.transaction === "string") txId = r.transaction;
          const tx = txId ? this.txs.get(txId) : undefined;
          const script = this.readScripts.shift();
          if (script && txId) {
            const name = ((r.documents as string[]) ?? [])[0] ?? "";
            const d = this.docs.get(name);
            tx?.reads.set(name, d?.version ?? 0);
            const otherTx = Buffer.from(`tx-other-${this.txSeq}`).toString("base64");
            const found = d ? { name, fields: d.fields, createTime: ts(d.version), updateTime: ts(d.version) } : undefined;
            const plan = script({ name, tx: txId, otherTx, found, readTime: ts(this.clock) });
            for (const res of plan.responses) call.write(res);
            if (plan.thenError) return void setTimeout(() => call.emit("error", { code: grpc.status.UNAVAILABLE, details: "synthetic mid-stream failure" }), 20);
            return void call.end();
          }
          const answer = () => {
          for (const name of (r.documents as string[]) ?? []) {
            const d = this.docs.get(name);
            tx?.reads.set(name, d?.version ?? 0);
            const base = { readTime: ts(this.clock), ...(r.newTransaction ? { transaction: txId } : {}) };
            call.write(d ? { ...base, found: { name, fields: this.wireFields(d.fields, "batchGet"), createTime: ts(d.version), updateTime: ts(d.version) } } : { ...base, missing: name });
          }
          call.end();
          };
          if (readFault === "read_hang") return; // never answers (the client's deadline must end it)
          if (readFault === "read_delay_1000") setTimeout(answer, 1000);
          else answer();
        },
        Commit: (call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          this.commitRpcs++;
          const r = call.request;
          const txId = typeof r.transaction === "string" ? r.transaction : undefined;
          const tx = txId ? this.txs.get(txId) : undefined;
          if (tx) {
            tx.commits++;
            this.commitsPerTx.push(tx.commits);
          }
          if (txId && (!tx || tx.finished)) return cb({ code: grpc.status.INVALID_ARGUMENT, details: "synthetic: transaction is no longer valid" });
          if (tx) tx.finished = true;
          const fault = this.faults.shift();
          if (fault === "aborted") return cb({ code: grpc.status.ABORTED, details: "synthetic ABORTED" });
          if (fault === "unavailable_not_applied") return cb({ code: grpc.status.UNAVAILABLE, details: "synthetic UNAVAILABLE" });
          if (fault === "resource_exhausted_not_applied") return cb({ code: grpc.status.RESOURCE_EXHAUSTED, details: "synthetic RESOURCE_EXHAUSTED" });
          if (fault === "unauthenticated_not_applied") return cb({ code: grpc.status.UNAUTHENTICATED, details: "synthetic UNAUTHENTICATED" });
          if (tx) for (const [name, v] of tx.reads) if ((this.docs.get(name)?.version ?? 0) !== v) return cb({ code: grpc.status.ABORTED, details: "synthetic conflict" });
          const writes = (r.writes as { update?: { name: string; fields?: Record<string, ProtoValue> } }[]) ?? [];
          const versions = writes.map((w) => {
            if (!w.update) return this.clock;
            const fields = w.update.fields ?? {};
            const previous = this.docs.get(w.update.name);
            const version = this.preserveUpdateTimeOnNoop && previous && isDeepStrictEqual(previous.fields, fields) ? previous.version : ++this.clock;
            this.docs.set(w.update.name, { fields, version });
            return version;
          });
          if (fault === "commit_lost") return cb({ code: grpc.status.UNAVAILABLE, details: "synthetic: applied, response lost" });
          if (fault === "commit_lost_late") return void setTimeout(() => cb({ code: grpc.status.UNAVAILABLE, details: "synthetic: applied, response lost (late)" }), 1500);
          cb(null, { commitTime: ts(this.clock), writeResults: versions.map((version) => ({ updateTime: ts(version) })) });
        },
        Rollback: (call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          this.rollbackRpcs++;
          this.rollbackTxs.push(typeof call.request.transaction === "string" ? call.request.transaction : "");
          if (this.rollbackHang) return; // never answers
          const finish = () => {
            if (this.failRollback) return cb({ code: grpc.status.UNAVAILABLE, details: "synthetic rollback failure" });
            const tx = typeof call.request.transaction === "string" ? this.txs.get(call.request.transaction) : undefined;
            if (tx) tx.finished = true;
            cb(null, {});
          };
          if (this.rollbackDelayMs > 0) setTimeout(finish, this.rollbackDelayMs);
          else finish();
        },
        BeginTransaction: (_call: grpc.ServerUnaryCall<ProtoValue, ProtoValue>, cb: grpc.sendUnaryData<ProtoValue>) => {
          const txId = Buffer.from(`tx-${++this.txSeq}`).toString("base64");
          this.txs.set(txId, { reads: new Map(), finished: false, commits: 0 });
          cb(null, { transaction: txId });
        },
      },
    );
    this.port = await new Promise<number>((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
    this.server = server;
  }

  stop(): void {
    this.server?.forceShutdown();
  }

  /** Applies the next admin fault; true when the call was answered (or deliberately left hanging). */
  private adminFault(cb: grpc.sendUnaryData<ProtoValue>): boolean {
    const f = this.adminFaults.shift();
    if (f === "hang") return true;
    if (f === "unavailable") {
      cb({ code: grpc.status.UNAVAILABLE, details: "synthetic UNAVAILABLE" });
      return true;
    }
    return false;
  }

  /** Paged answer: pageToken = offset; `emptyPagesBefore` empty pages (still with a token) come first. */
  private page<T>(r: ProtoValue, items: T[], toWire: (x: T) => unknown, field: string, cb: grpc.sendUnaryData<ProtoValue>): void {
    const token = typeof r.pageToken === "string" ? r.pageToken : "";
    if (this.emptyPagesBefore > 0 && !token.startsWith("o")) {
      this.emptyPagesBefore--;
      return cb(null, { [field]: [], nextPageToken: this.emptyPagesBefore > 0 ? "e" : "o0" });
    }
    const offset = token.startsWith("o") ? Number(token.slice(1)) : 0;
    const size = typeof r.pageSize === "number" && r.pageSize > 0 ? r.pageSize : 100;
    const slice = items.slice(offset, offset + size);
    const next = offset + size < items.length ? `o${offset + size}` : "";
    cb(null, { [field]: slice.map(toWire), nextPageToken: next });
  }
}

// ---------------------------------------------------------------------------
// Shared-contract environments
// ---------------------------------------------------------------------------

export type FakeApiEnv = SharedStoreEnv & { api: FakeFirestoreApi; connects: () => number };

/** FirestoreUsageStore over the API fake: every instance shares the fake "database". */
export function fakeApiEnv(opts: { ignoreMaxAttemptsWith?: number } = {}): FakeApiEnv {
  let t = 0;
  const now = () => t;
  const api = new FakeFirestoreApi();
  api.ignoreMaxAttemptsWith = opts.ignoreMaxAttemptsWith;
  let connects = 0;
  const path = (key: string) => `${USAGE_COLLECTION}/${keyToDocId(key)}`;
  const countOf = (d: FakeDoc): unknown => (typeof d.data === "object" && d.data !== null ? (d.data as Record<string, unknown>).count : d.data);
  return {
    label: "FirestoreUsageStore over FakeFirestoreApi (TEST ONLY, NOT Firestore)",
    newStore: () =>
      new FirestoreUsageStore(async () => {
        connects++;
        return { db: api, Timestamp: TS } satisfies FirestoreDeps;
      }, now),
    now,
    setNow: (v) => void (t = v),
    isContentionError: (e) => e instanceof FirestoreUsageStoreError && e.reason === "contention",
    backend: {
      observe: (key): CounterObservation => {
        const d = api.docs.get(path(key));
        return d ? { exists: true, raw: countOf(d) } : { exists: false };
      },
      snapshot: () => new Map([...api.docs].map(([p, d]) => [docIdToKey(p.slice(USAGE_COLLECTION.length + 1)), countOf(d)])),
      setRaw: (key, value) => api.setDoc(path(key), wellFormedDoc(value, t)),
      inject: (...f) => api.inject(...f),
    },
    api,
    connects: () => connects,
  };
}

export type GrpcEnv = SharedStoreEnv & { server: FakeFirestoreGrpcServer };

/**
 * "production": the PRODUCTION connector (sdkConnector: GAPIC client initialised and awaited,
 * Commit without retry) pointed at the fake server over an insecure local channel.
 * "sdk_default_retry": NEGATIVE CONTROL — the same GAPIC adapter, but with google-gax's DEFAULT
 * client config and call options (Commit retried on UNAVAILABLE / RESOURCE_EXHAUSTED).
 */
export type GrpcMode = "production" | "sdk_default_retry";

function defaultRetryConnector(port: number): () => Promise<FirestoreDeps> {
  return async () => {
    const v1 = (firestoreSdk as unknown as { v1: { FirestoreClient: new (o: Record<string, unknown>, g: unknown) => ConstructorParameters<typeof GapicFirestore>[0] } }).v1;
    const client = new v1.FirestoreClient({ projectId: "demo-allergy-bridge", servicePath: "127.0.0.1", port, sslCreds: grpc.credentials.createInsecure(), fallback: false }, gax);
    await client.initialize();
    return { db: new GapicFirestore(client, "demo-allergy-bridge", Timestamp as unknown as ConstructorParameters<typeof GapicFirestore>[2], { commitCallOptions: {}, emulatorAuthHeader: true }), Timestamp: TS };
  };
}

export function grpcEnv(server: FakeFirestoreGrpcServer, stores: FirestoreUsageStore[], mode: GrpcMode = "production"): GrpcEnv {
  let t = 0;
  const now = () => t;
  server.reset();
  const countOf = (d: ServerDoc) => decodeValue(d.fields.count);
  const prefix = `projects/demo-allergy-bridge/databases/(default)/documents/${USAGE_COLLECTION}/`;
  return {
    label: "FirestoreUsageStore over the PRODUCTION connector (real SDK GAPIC client, google-gax, gRPC) → fake gRPC server (TEST ONLY, NOT Firestore)",
    newStore: () => {
      const connect = mode === "production" ? sdkConnector("demo-allergy-bridge", { endpoint: { host: `127.0.0.1:${server.port}`, ssl: false } }) : defaultRetryConnector(server.port);
      const store = new FirestoreUsageStore(connect, now);
      stores.push(store);
      return store;
    },
    now,
    setNow: (v) => void (t = v),
    isContentionError: (e) => e instanceof FirestoreUsageStoreError && e.reason === "contention",
    backend: {
      observe: (key): CounterObservation => {
        const d = server.docs.get(server.docName(key));
        return d ? { exists: true, raw: countOf(d) } : { exists: false };
      },
      snapshot: () => new Map([...server.docs].map(([name, d]) => [docIdToKey(name.slice(prefix.length)), countOf(d)])),
      setRaw: (key, value) => server.setFields(key, wellFormedDoc(value, t)),
      inject: (...f) => server.inject(...f),
    },
    server,
  };
}
