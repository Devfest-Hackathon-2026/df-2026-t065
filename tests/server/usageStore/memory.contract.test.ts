import { InMemoryUsageStore } from "@/server/usage/store";
import { describeMemoryUsageStoreContract, type MemoryStoreEnv } from "./contract";

/*
 * The common UsageStore contract applied to the CURRENT in-memory store
 * (development / tests only). One process has one map: the SHARED-store
 * requirements (several instances on one backend, direct counter observation,
 * fault injection) do not apply to it. They are NOT skipped here — they live in
 * describeSharedUsageStoreContract, which a shared store must pass in full
 * (tests/server/usageStore/reference.contract.test.ts; later the Firestore store).
 */
const DAY = 86_400_000;

describeMemoryUsageStoreContract((): MemoryStoreEnv => {
  let t = 0;
  const now = () => t;
  const store = new InMemoryUsageStore(now);
  return {
    label: "InMemoryUsageStore (current, dev/test only)",
    newStore: () => store,
    now,
    setNow: (v) => void (t = v),
    // The in-memory store exposes no read: observe by a probe that adds one unit
    // under an unreachable limit (always allowed) and subtracts it. Called last.
    observeUnits: async (s, key) => {
      const r = await s.consume(key, 1, Number.MAX_SAFE_INTEGER, t + DAY);
      if (!r.allowed || !Number.isSafeInteger(r.count) || r.count < 1) throw new Error("observeUnits probe was not allowed");
      return r.count - 1;
    },
  };
});
