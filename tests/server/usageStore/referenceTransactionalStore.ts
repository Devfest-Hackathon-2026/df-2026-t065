import { assertConsumeArgs, type ConsumeResult, type UsageStore } from "@/server/usage/store";

/*
 * TEST ONLY — a reference model of a SHARED, TRANSACTIONAL usage store.
 *
 * THIS IS NOT FIRESTORE and says nothing about how Firestore or its SDK behave.
 * It exists so that the common UsageStore contract
 * (tests/server/usageStore/contract.ts) can express, today, the properties a
 * future shared store (e.g. a Firestore-backed one) must satisfy:
 *  - several store instances (Cloud Run instances) share ONE backend;
 *  - a read-modify-write is applied atomically (all or nothing);
 *  - faults can be injected: a commit whose response is lost after it was
 *    applied, a contention abort, and corrupted stored values.
 * A future Firestore implementation must pass the same contract against its
 * own backend (emulator / real SDK) — passing it here does not prove that.
 */

/** Faults the reference backend can inject into the NEXT transaction attempt. */
export type BackendFault =
  | "none" // no fault for this attempt (lets tests place faults on later attempts)
  | "commit_lost" // the writes ARE applied, then the caller receives an error (outcome unknown to it)
  | "aborted"; // contention: nothing is applied, the caller receives an error

/** True only for the reference backend's contention abort (nothing was applied). */
export function isSyntheticContention(e: unknown): boolean {
  return e instanceof SyntheticBackendError && e.code === "ABORTED";
}

export class SyntheticBackendError extends Error {
  constructor(
    readonly code: "DEADLINE_EXCEEDED" | "ABORTED",
    message: string,
  ) {
    super(message);
    this.name = "SyntheticBackendError";
  }
}

type Tx = { get(key: string): unknown; set(key: string, value: number): void };

export class FakeTransactionalBackend {
  private readonly docs = new Map<string, unknown>();
  private readonly faults: BackendFault[] = [];
  /** Number of transactions whose writes were applied (including "commit_lost" ones). */
  appliedCommits = 0;
  /** Number of transaction attempts started. */
  attempts = 0;

  /** Queue a fault for the next transaction attempt(s), in order. */
  inject(...faults: BackendFault[]): void {
    this.faults.push(...faults);
  }
  /** Raw stored value for a key (may be anything, to model corrupted data). */
  raw(key: string): unknown {
    return this.docs.get(key);
  }
  setRaw(key: string, value: unknown): void {
    this.docs.set(key, value);
  }
  remove(key: string): void {
    this.docs.delete(key);
  }
  /** Direct observation of one stored counter: absent, or present with its raw value. */
  observe(key: string): { exists: false } | { exists: true; raw: unknown } {
    return this.docs.has(key) ? { exists: true, raw: this.docs.get(key) } : { exists: false };
  }
  /** A copy of every stored key and raw value (to detect writes to unrelated keys). */
  snapshot(): ReadonlyMap<string, unknown> {
    return new Map(this.docs);
  }

  /**
   * Runs `fn` once as one atomic read-modify-write. `fn` is synchronous, so its
   * reads and writes cannot interleave with another transaction in this process;
   * the writes are applied together at "commit".
   */
  async runTransaction<T>(fn: (tx: Tx) => T): Promise<T> {
    this.attempts++;
    await Promise.resolve(); // an asynchronous boundary, like a network round trip
    const fault = this.faults.shift();
    if (fault === "aborted") throw new SyntheticBackendError("ABORTED", "synthetic contention abort (nothing applied)");
    const writes = new Map<string, number>();
    const result = fn({ get: (k) => this.docs.get(k), set: (k, v) => void writes.set(k, v) });
    for (const [k, v] of writes) this.docs.set(k, v);
    if (writes.size > 0) this.appliedCommits++;
    if (fault === "commit_lost") throw new SyntheticBackendError("DEADLINE_EXCEEDED", "synthetic: applied, but the response was lost");
    return result;
  }
}

/** Thrown when a stored counter value is not a non-negative safe integer. */
export class CorruptStoredValueError extends Error {
  constructor() {
    super("corrupt stored counter value");
    this.name = "CorruptStoredValueError";
  }
}

function storedCount(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new CorruptStoredValueError();
  return raw;
}

const isRetryable = (e: unknown) => e instanceof SyntheticBackendError;

/**
 * TEST ONLY — the reference adapter: UsageStore over the shared backend.
 * `maxAttempts` defaults to 1 (no retry). A value > 1 models a client library
 * that re-runs the whole transaction after an error (used as a NEGATIVE
 * CONTROL: it can apply one logical reservation more than once).
 */
export class ReferenceTransactionalUsageStore implements UsageStore {
  readonly kind = "reference-transactional (test only, NOT Firestore)";
  constructor(
    private readonly backend: FakeTransactionalBackend,
    private readonly now: () => number,
    private readonly options: { maxAttempts?: number; nonAtomic?: boolean } = {},
  ) {}

  async consume(key: string, amount: number, limit: number, expiresAtMs: number): Promise<ConsumeResult> {
    assertConsumeArgs(amount, limit, expiresAtMs, this.now());
    if (this.options.nonAtomic) return this.consumeNonAtomic(key, amount, limit);
    const maxAttempts = this.options.maxAttempts ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await this.backend.runTransaction((tx) => {
          const current = storedCount(tx.get(key));
          if (current + amount > limit) return { allowed: false, count: current };
          tx.set(key, current + amount);
          return { allowed: true, count: current + amount };
        });
        return { allowed: r.allowed, count: r.count }; // a fresh plain object of our own
      } catch (e) {
        lastError = e;
        if (!isRetryable(e)) break;
      }
    }
    throw lastError;
  }

  /** NEGATIVE CONTROL: read, then await, then write — NOT atomic. */
  private async consumeNonAtomic(key: string, amount: number, limit: number): Promise<ConsumeResult> {
    const current = storedCount(this.backend.raw(key));
    await new Promise((r) => setTimeout(r, 0));
    if (current + amount > limit) return { allowed: false, count: current };
    this.backend.setRaw(key, current + amount);
    this.backend.appliedCommits++;
    return { allowed: true, count: current + amount };
  }
}
