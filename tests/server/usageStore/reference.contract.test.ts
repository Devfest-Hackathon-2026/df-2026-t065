import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConsumeResult, UsageStore } from "@/server/usage/store";
import {
  ContractViolation,
  MissingCapabilityError,
  assertSharedCapabilities,
  checkConcurrencySafety,
  checkLogBounds,
  checkStateDelta,
  classifySettled,
  describeSharedUsageStoreContract,
  storedUnits,
  verifyConcurrentState,
  verifyGuardedLostCommit,
  verifyLostCommitResponse,
  type SharedStoreEnv,
} from "./contract";
import { CorruptStoredValueError, FakeTransactionalBackend, ReferenceTransactionalUsageStore, SyntheticBackendError, isSyntheticContention } from "./referenceTransactionalStore";

/*
 * The common UsageStore contract applied to a TEST-ONLY reference model of a
 * shared transactional store (NOT Firestore), through the SHARED registration
 * function (every shared requirement is mandatory; nothing is skipped).
 * The negative controls below show that the contract's checks ACCEPT a store
 * that is safe but unavailable under contention, and DETECT stores that are
 * unsafe while their responses look normal.
 */

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const EXP = T0 + 86_400_000;

function referenceEnv(storeFor?: (backend: FakeTransactionalBackend, now: () => number) => UsageStore): SharedStoreEnv & { raw: FakeTransactionalBackend } {
  let t = 0;
  const now = () => t;
  const backend = new FakeTransactionalBackend();
  return {
    label: "ReferenceTransactionalUsageStore (TEST ONLY, NOT Firestore; maxAttempts 1)",
    newStore: () => (storeFor ? storeFor(backend, now) : new ReferenceTransactionalUsageStore(backend, now)),
    now,
    setNow: (v) => void (t = v),
    backend,
    isContentionError: isSyntheticContention,
    raw: backend,
  };
}

describeSharedUsageStoreContract(() => referenceEnv());

/** A broken adapter: runs `mutate` inside the transaction instead of the correct write. */
function brokenStore(backend: FakeTransactionalBackend, mutate: (tx: { get(k: string): unknown; set(k: string, v: number): void }, key: string, amount: number) => void, removeAfter = false): UsageStore {
  return {
    kind: "broken (negative control)",
    async consume(key, amount) {
      try {
        return await backend.runTransaction((tx) => {
          const cur = Number(tx.get(key) ?? 0);
          mutate(tx, key, amount);
          return { allowed: true, count: cur + amount } satisfies ConsumeResult;
        });
      } finally {
        if (removeAfter) backend.remove(key); // the value is lost whatever the response
      }
    },
  };
}

describe("negative controls: C5 separates SAFETY from AVAILABILITY", () => {
  it("SAFE but unavailable: 60 calls, 1 applied, 59 ABORTED → the safety checks PASS", async () => {
    const env = referenceEnv();
    env.setNow(T0);
    const s = env.newStore();
    env.raw.inject("none", ...Array.from({ length: 59 }, () => "aborted" as const));
    const settled = await Promise.allSettled(Array.from({ length: 60 }, () => s.consume("k", 1, 10, EXP)));
    const outcomes = classifySettled(settled, 1, 10, env.isContentionError);
    expect(outcomes.filter((o) => o.kind === "contention")).toHaveLength(59);
    expect(outcomes.filter((o) => o.kind === "allowed")).toHaveLength(1);
    expect(() => checkConcurrencySafety(outcomes, 1, 10, storedUnits(env.backend.observe("k"), { mustExist: true }))).not.toThrow();
  });

  it("LYING store: limit 10, stored counter driven to 60 while every response looks valid → FAIL", async () => {
    const env = referenceEnv();
    env.setNow(T0);
    let answered = 0;
    const lying: UsageStore = {
      kind: "lying (negative control)",
      async consume(key, amount, limit) {
        const cur = Number(env.raw.raw(key) ?? 0);
        env.raw.setRaw(key, cur + amount); // ALWAYS applied
        answered += amount;
        return answered <= limit ? { allowed: true, count: answered } : { allowed: false, count: limit };
      },
    };
    const settled = await Promise.allSettled(Array.from({ length: 60 }, () => lying.consume("k", 1, 10, EXP)));
    const outcomes = classifySettled(settled, 1, 10, env.isContentionError); // every response passes the output contract
    expect(env.backend.observe("k")).toEqual({ exists: true, raw: 60 });
    expect(() => checkConcurrencySafety(outcomes, 1, 10, storedUnits(env.backend.observe("k"), { mustExist: true }))).toThrow(/stored counter 60 exceeds limit 10/);
  });

  it("a DENIAL that is applied is detected even when the stored counter stays ≤ limit", () => {
    const outcomes = [{ kind: "allowed", count: 1 } as const, { kind: "denied", count: 1 } as const];
    expect(() => checkConcurrencySafety(outcomes, 1, 10, 2)).toThrow(/≠ allowed units 1/);
  });

  it("an UNRELATED exception under concurrency is a violation (only structured contention is tolerated)", async () => {
    const settled = await Promise.allSettled([Promise.resolve({ allowed: true, count: 1 }), Promise.reject(new TypeError("boom")), Promise.reject(new SyntheticBackendError("DEADLINE_EXCEEDED", "x"))]);
    expect(() => classifySettled(settled, 1, 10, isSyntheticContention)).toThrow(ContractViolation);
    expect(() => classifySettled([settled[2]!], 1, 10, isSyntheticContention)).toThrow(/unrelated failure/);
  });

  it("a fulfilled result outside the output contract is a violation", async () => {
    const settled = await Promise.allSettled([Promise.resolve({ allowed: true, count: 11 })]);
    expect(() => classifySettled(settled, 1, 10, isSyntheticContention)).toThrow(/output contract/);
  });

  it("a NON-ATOMIC store (read, await, write) over-allows under concurrency → C5 safety FAILS", async () => {
    const backend = new FakeTransactionalBackend();
    const broken = new ReferenceTransactionalUsageStore(backend, () => T0, { nonAtomic: true });
    const settled = await Promise.allSettled(Array.from({ length: 30 }, () => broken.consume("k", 1, 10, EXP)));
    const outcomes = classifySettled(settled, 1, 10, isSyntheticContention);
    expect(() => checkConcurrencySafety(outcomes, 1, 10, storedUnits(backend.observe("k"), { mustExist: true }))).toThrow(ContractViolation);
  });
});

describe("negative controls: C7 checks the STORED counter, units (not commits) and other keys", () => {
  const run = (store: (b: FakeTransactionalBackend) => UsageStore, amount = 1, existing?: number) => {
    const env = referenceEnv((b) => store(b));
    env.setNow(T0);
    if (existing !== undefined) env.backend.setRaw("k", existing);
    return verifyLostCommitResponse(env, env.newStore(), "k", amount, 10, EXP);
  };

  it("the correct reference store (maxAttempts 1) passes and surfaces the lost response as a failure", async () => {
    await expect(run((b) => new ReferenceTransactionalUsageStore(b, () => T0))).resolves.toEqual({ rejected: true });
    await expect(run((b) => new ReferenceTransactionalUsageStore(b, () => T0), 2, 3)).resolves.toEqual({ rejected: true });
  });

  it("only ANOTHER key is incremented (target unchanged) → FAIL", async () => {
    await expect(run((b) => brokenStore(b, (tx, key, amount) => tx.set(`${key}:other`, amount)))).rejects.toThrow(/missing although it must exist/);
    await expect(run((b) => brokenStore(b, (tx, key, amount) => tx.set(`${key}:other`, amount)), 1, 3)).rejects.toThrow(/increased by 0/);
  });

  it("the target is right but another key is ALSO written → FAIL", async () => {
    await expect(run((b) => brokenStore(b, (tx, key, amount) => (tx.set(key, Number(tx.get(key) ?? 0) + amount), tx.set("collateral", 1))))).rejects.toThrow(/unrelated key was created: collateral/);
  });

  it("the same reservation is applied TWICE (whole-transaction retry, maxAttempts 5) → FAIL", async () => {
    await expect(run((b) => new ReferenceTransactionalUsageStore(b, () => T0, { maxAttempts: 5 }))).rejects.toThrow(/increased by 2, expected exactly 1/);
  });

  it("the stored value goes MISSING after the call → FAIL", async () => {
    await expect(run((b) => brokenStore(b, (tx, key, amount) => tx.set(key, Number(tx.get(key) ?? 0) + amount), true), 1, 3)).rejects.toThrow(/missing although it must exist/);
  });

  it("the stored value becomes NaN → FAIL", async () => {
    await expect(run((b) => brokenStore(b, (tx, key) => tx.set(key, Number.NaN)))).rejects.toThrow(/not a non-negative safe integer: NaN/);
  });

  it("amount = 2 but only 1 unit is added (one commit, wrong units) → FAIL", async () => {
    await expect(run((b) => brokenStore(b, (tx, key) => tx.set(key, Number(tx.get(key) ?? 0) + 1)), 2)).rejects.toThrow(/increased by 1, expected exactly 2/);
  });

  it("strict observation: absent / NaN / Infinity / fractional / negative are distinguished", () => {
    expect(storedUnits({ exists: false }, { mustExist: false })).toBe(0);
    expect(() => storedUnits({ exists: false }, { mustExist: true })).toThrow(/missing/);
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, "1", null, undefined]) expect(() => storedUnits({ exists: true, raw: v }, { mustExist: false })).toThrow(ContractViolation);
  });

  it("log bounds reject NaN / non-integers and an under- or over-count", () => {
    expect(() => checkLogBounds(Number.NaN, 0, 1)).toThrow(/consumed/);
    expect(() => checkLogBounds(1, 0.5, 1)).toThrow(/reserved/);
    expect(() => checkLogBounds(0, 1, 0)).toThrow(/outside/); // a confirmed reservation is missing from the store
    expect(() => checkLogBounds(2, 0, 1)).toThrow(/outside/); // more stored than the guard could account for
    expect(() => checkLogBounds(1, 0, 1)).not.toThrow();
  });
});

/**
 * A correct atomic adapter with injectable side effects (negative controls of the
 * 2nd audit). `onDeny` / `onAllow` run INSIDE the transaction; `afterDeny` after it.
 */
function sideEffectStore(
  backend: FakeTransactionalBackend,
  fx: { onDeny?: (tx: { get(k: string): unknown; set(k: string, v: number): void }) => void; afterDeny?: () => void; onAllow?: (tx: { get(k: string): unknown; set(k: string, v: number): void }, key: string) => void },
): UsageStore {
  return {
    kind: "side-effect (negative control)",
    async consume(key, amount, limit) {
      const r = await backend.runTransaction((tx) => {
        const raw = tx.get(key);
        if (raw !== undefined && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)) throw new CorruptStoredValueError();
        const cur = (raw as number | undefined) ?? 0;
        if (cur + amount > limit) {
          fx.onDeny?.(tx);
          return { allowed: false, count: cur };
        }
        tx.set(key, cur + amount);
        fx.onAllow?.(tx, key);
        return { allowed: true, count: cur + amount };
      });
      if (!r.allowed) fx.afterDeny?.();
      return r;
    },
  };
}
const inc = (tx: { get(k: string): unknown; set(k: string, v: number): void }, k: string) => tx.set(k, Number(tx.get(k) ?? 0) + 1);

describe("negative controls (2nd audit, MAJOR-1): C5 observes the WHOLE state, not only the target", () => {
  const atLimit = { instances: 1, calls: 30, amount: 1, limit: 10, presetTarget: 10 };
  const fromZero = { instances: 3, calls: 60, amount: 1, limit: 10 };

  it.each([
    ["A creates a new key `collateral`", { onDeny: (tx: Parameters<typeof inc>[0]) => tx.set("collateral", 1) }, /unrelated key was created: collateral/],
    ["B updates an existing other key", { onDeny: (tx: Parameters<typeof inc>[0]) => inc(tx, "bystander") }, /unrelated key was updated: bystander/],
  ])("on a denial, %s (target kept at 10) → FAIL", async (_n, fx, msg) => {
    const env = referenceEnv((b) => sideEffectStore(b, fx));
    await expect(verifyConcurrentState(env, atLimit)).rejects.toThrow(msg);
    const env2 = referenceEnv((b) => sideEffectStore(b, fx));
    await expect(verifyConcurrentState(env2, fromZero)).rejects.toThrow(msg); // also when denials follow allowances
  });

  it("on a denial, C deletes another key (target kept at 10) → FAIL", async () => {
    const env = referenceEnv((b) => sideEffectStore(b, { afterDeny: () => b.remove("bystander") }));
    await expect(verifyConcurrentState(env, atLimit)).rejects.toThrow(/unrelated key was deleted: bystander/);
  });

  it("the same side-effect-free adapter passes (control of the control)", async () => {
    await expect(verifyConcurrentState(referenceEnv((b) => sideEffectStore(b, {})), atLimit)).resolves.toHaveLength(30);
    await expect(verifyConcurrentState(referenceEnv((b) => sideEffectStore(b, {})), fromZero)).resolves.toHaveLength(60);
  });

  it("D 60 calls: 1 allowed, 59 ABORTED without any write → the safety procedure PASSES", async () => {
    const env = referenceEnv();
    const outcomes = await verifyConcurrentState(env, { instances: 3, calls: 60, amount: 1, limit: 10, faults: ["none", ...Array.from({ length: 59 }, () => "aborted" as const)] });
    expect(outcomes.filter((o) => o.kind === "contention")).toHaveLength(59);
    expect(outcomes.filter((o) => o.kind === "allowed")).toHaveLength(1);
  });

  it("E the stored counter is driven above the limit while the responses look valid → FAIL", async () => {
    let answered = 0;
    const env = referenceEnv((b) => ({
      kind: "lying",
      async consume(key, amount, limit) {
        b.setRaw(key, Number(b.raw(key) ?? 0) + amount);
        answered += amount;
        return answered <= limit ? { allowed: true, count: answered } : { allowed: false, count: limit };
      },
    }));
    await expect(verifyConcurrentState(env, { instances: 1, calls: 60, amount: 1, limit: 10 })).rejects.toThrow(/stored counter 60 exceeds limit 10/);
  });

  it("strict whole-state comparison: no 0-conversion of absent or invalid values", () => {
    const m = (o: Record<string, unknown>) => new Map(Object.entries(o));
    expect(() => checkStateDelta(m({}), m({ x: 0 }), {})).toThrow(/created: x/); // a created 0 is still a creation
    expect(() => checkStateDelta(m({ x: Number.NaN }), m({ x: Number.NaN }), {})).not.toThrow(); // literally unchanged
    expect(() => checkStateDelta(m({ x: 0 }), m({ x: -0 }), {})).toThrow(/updated: x/);
    expect(() => checkStateDelta(m({ k: 3 }), m({}), { k: 0 })).toThrow(/changed although no unit/);
    expect(() => checkStateDelta(m({}), m({ k: 0 }), { k: 0 })).toThrow(/changed although no unit/);
    expect(() => checkStateDelta(m({ k: Number.NaN }), m({ k: 1 }), { k: 1 })).toThrow(/NaN/);
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, "2", null]) expect(() => checkStateDelta(m({}), m({ k: v }), { k: 1 })).toThrow(ContractViolation);
  });
});

describe("negative controls (2nd audit, MAJOR-2): C7 through the guard / runner, and resolved answers are validated separately", () => {
  it("A the daily key is incremented correctly but ANOTHER key too → FAIL (guard / runner path)", async () => {
    const env = referenceEnv((b) => sideEffectStore(b, { onAllow: (tx, key) => key.startsWith("daily:") && inc(tx, "collateral") }));
    await expect(verifyGuardedLostCommit(env)).rejects.toThrow(/unrelated key was created: collateral/);
    const env2 = referenceEnv((b) => sideEffectStore(b, { onAllow: (tx, key) => key.startsWith("daily:") && inc(tx, "bystander") }));
    env2.backend.setRaw("bystander", 7);
    await expect(verifyGuardedLostCommit(env2)).rejects.toThrow(/unrelated key was updated: bystander/);
  });

  it("A' with the route's rate check: a second write to the rate key (rate +2) → FAIL", async () => {
    const env = referenceEnv((b) => sideEffectStore(b, { onAllow: (tx, key) => key.startsWith("rate:") && tx.set(key, Number(tx.get(key) ?? 0) + 2) }));
    await expect(verifyGuardedLostCommit(env, { withRate: true })).rejects.toThrow(/rate:c:\d+ increased by 2, expected exactly 1/);
  });

  it("B only the target is incremented correctly and only the response is lost → PASS (store and guard / runner)", async () => {
    const env = referenceEnv();
    env.setNow(T0);
    await expect(verifyLostCommitResponse(env, env.newStore(), "k", 1, 10, EXP)).resolves.toEqual({ rejected: true });
    const { out, starts } = await verifyGuardedLostCommit(referenceEnv());
    expect(starts).toBe(0);
    expect(out).toMatchObject({ ok: false, failure: "usage_store_error", reserved: 0, reservationsUnknown: 1 });
  });

  const resolving = (answer: (count: number) => unknown) => (b: FakeTransactionalBackend): UsageStore => ({
    kind: "resolving (negative control)",
    async consume(key, amount) {
      const next = Number(b.raw(key) ?? 0) + amount;
      b.setRaw(key, next); // applied correctly, exactly once
      return answer(next) as ConsumeResult;
    },
  });
  const runStore = (store: (b: FakeTransactionalBackend) => UsageStore) => {
    const env = referenceEnv(store);
    env.setNow(T0);
    return verifyLostCommitResponse(env, env.newStore(), "k", 1, 10, EXP);
  };

  it("C a resolved { allowed: true, count: NaN } is NOT absorbed as the expected failure → FAIL", async () => {
    await expect(runStore(resolving(() => ({ allowed: true, count: Number.NaN })))).rejects.toThrow(/resolved response violates the output contract/);
  });

  it.each([
    ["an extra key", (c: number) => ({ allowed: true, count: c, extra: 1 })],
    ["a string count", (c: number) => ({ allowed: true, count: String(c) })],
    ["a non-boolean allowed", (c: number) => ({ allowed: "true", count: c })],
    ["null", () => null],
  ])("D a resolved contract-violating object (%s) → FAIL", async (_n, ans) => {
    await expect(runStore(resolving(ans))).rejects.toThrow(/resolved response violates the output contract/);
  });

  it("D' a resolved valid-looking answer that disagrees with the stored counter (applied but says denied / wrong count) → FAIL", async () => {
    await expect(runStore(resolving((c) => ({ allowed: false, count: c })))).rejects.toThrow(/disagrees with the stored counter/);
    await expect(runStore(resolving((c) => ({ allowed: true, count: c + 1 })))).rejects.toThrow(/disagrees with the stored counter/);
    await expect(runStore(resolving((c) => ({ allowed: true, count: c })))).resolves.toEqual({ rejected: false }); // the correct resolved answer passes
  });

  it("E the model starts although the reservation outcome is unknown (a hook that treats store_error as allowed) → FAIL", async () => {
    const lenient = async (g: import("@/server/usage/guard").UsageGuard, d: number) => {
      const r = await g.reserveInference(d);
      return r.decision === "store_error" ? { decision: "allowed" as const, validFromMs: Date.UTC(2026, 10, 6, 15), validUntilMs: Date.UTC(2026, 10, 7, 15) } : r;
    };
    await expect(verifyGuardedLostCommit(referenceEnv(), { reserve: lenient })).rejects.toThrow(/S3: 1 model start\(s\) with 0 confirmed reservation/);
  });

  it("E' log bounds: an unknown outcome that is dropped (reserved 0, unknown 0) → FAIL", async () => {
    const dropping = async (g: import("@/server/usage/guard").UsageGuard, d: number) => {
      const r = await g.reserveInference(d);
      return r.decision === "store_error" ? { decision: "limited" as const } : r;
    };
    await expect(verifyGuardedLostCommit(referenceEnv(), { reserve: dropping })).rejects.toThrow(/consumed 1 outside \[0, 0\]/);
  });
});

describe("negative controls: the shared registration refuses incomplete environments (MAJOR-3)", () => {
  const full = () => referenceEnv() as Record<string, unknown>;
  it.each([
    ["no backend", (e: Record<string, unknown>) => void delete e.backend, /backend/],
    ["no fault injection", (e: Record<string, unknown>) => void (e.backend = { ...(e.raw as object), observe: () => ({ exists: false }), snapshot: () => new Map(), setRaw: () => {} }), /backend\.inject/],
    ["no direct observation", (e: Record<string, unknown>) => void (e.backend = { inject: () => {}, snapshot: () => new Map(), setRaw: () => {} }), /backend\.observe/],
    ["no contention classifier", (e: Record<string, unknown>) => void delete e.isContentionError, /isContentionError/],
  ])("%s → MissingCapabilityError (would fail at registration)", (_n, strip, msg) => {
    const e = full();
    strip(e);
    expect(() => assertSharedCapabilities(e)).toThrow(MissingCapabilityError);
    expect(() => assertSharedCapabilities(e)).toThrow(msg);
    expect(() => describeSharedUsageStoreContract(() => e as unknown as SharedStoreEnv)).toThrow(MissingCapabilityError);
  });

  it("the contract module contains no skip / conditional / todo path (a required check cannot be skipped silently)", () => {
    const src = readFileSync(fileURLToPath(new URL("./contract.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/\.(skip|skipIf|runIf|todo|only)\b/);
    expect(src).not.toMatch(/\bctx\.skip\b|\bthis\.skip\b/);
  });
});

/*
 * FirestoreUsageStore (PR-F2) is implemented and passes describeSharedUsageStoreContract
 * over a fake of the Firestore API (firestore.unit.test.ts) and with the REAL SDK
 * against a local fake gRPC server (firestore.grpc.test.ts). What is still NOT
 * verified needs a real Firestore database or the Firestore emulator (separate
 * approval). These remain TODO, never PASS; production refuses the store until then.
 */
describe("FirestoreUsageStore on a REAL Firestore / the emulator — NOT VERIFIED", () => {
  it.todo("passes describeSharedUsageStoreContract against the Firestore emulator and a real (default) database (C1–C10), several Cloud Run instances on one database");
  it.todo("S1 on a real server: a lost commit response is never re-applied — including gRPC transparent retries and what the server does with a re-sent Commit (the SDK's own re-send is disabled and verified only against a fake gRPC server)");
  it.todo("S1/S2 on a real server: DEADLINE_EXCEEDED / UNAVAILABLE after an applied commit is surfaced as unknown_outcome and counted as unknown (verified only against fakes)");
  it.todo("S4 on a real server: ABORTED under contention is surfaced as contention and never over-counts; measure the contention / failure rate under load (single daily document, maxAttempts: 1)");
  it.todo("real data: stored field types written by other tools (integer vs. double, missing field, Timestamp) are validated and corrupt documents fail closed");
  it.todo("operational: TTL policy on deleteAfter (2-day retention candidate), IAM (roles/datastore.user only), database location and cost verified on the real project");
  it.todo("CI: a required job runs the shared contract against the Firestore emulator (today only the fakes run in npm run verify)");
});
