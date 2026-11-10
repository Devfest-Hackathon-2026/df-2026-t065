import {
  STAFF_RESPONSE_STORAGE_KEY, hashStaffResponseContext,
  restoreStaffResponses, saveStaffResponses, type StaffAnswers,
} from "./staffResponseStorage";
import { responseTransaction, type ResponseState, type ResponseTransaction } from "./staffResponseDatabase";

// Legacy answers are discarded, never imported. Obsolete running clients must be reloaded.
export const STAFF_RESPONSE_EPOCH_KEY = "allergy_bridge_staff_response_epoch";
export const STAFF_RESPONSE_RETIRED = "retired:indexeddb-v3";
export const STAFF_RESPONSE_SIGNAL_KEY = "allergy_bridge_staff_response_signal_v3";
export const STAFF_RESPONSE_LOCK = "allergy_bridge_staff_responses_v2";
const epochPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Result = {
  status: "saved" | "restored" | "missing" | "rejected" | "unavailable" | "deleted" | "deleteFailed" | "noLock" | "noLockDelete";
  answers?: StaffAnswers;
};
export type ResponsePersistenceRuntime = {
  lock?: <T>(task: () => T | Promise<T>) => Promise<T>;
  transaction: ResponseTransaction;
  cleanupLegacy: () => void;
  notify: () => void;
  newEpoch: () => string;
  hash: (context: string) => Promise<string>;
  subscribe: (invalidate: () => void) => () => void;
};
type Callbacks = { reset: () => void; ready: (revision: number) => void; result: (result: Result) => void };

export function browserResponseRuntime(): ResponsePersistenceRuntime {
  let lock: ResponsePersistenceRuntime["lock"];
  try {
    if (navigator.locks?.request) lock = (task) => navigator.locks.request(STAFF_RESPONSE_LOCK, { mode: "exclusive" }, task);
  } catch { /* Memory-only fallback. */ }
  return {
    lock, transaction: responseTransaction,
    cleanupLegacy: () => {
      localStorage.setItem(STAFF_RESPONSE_EPOCH_KEY, STAFF_RESPONSE_RETIRED);
      localStorage.removeItem(STAFF_RESPONSE_STORAGE_KEY);
      if (localStorage.getItem(STAFF_RESPONSE_STORAGE_KEY) !== null) throw new Error("Legacy cleanup failed");
    },
    notify: () => localStorage.setItem(STAFF_RESPONSE_SIGNAL_KEY, crypto.randomUUID()),
    newEpoch: () => crypto.randomUUID(), hash: hashStaffResponseContext,
    subscribe: (invalidate) => {
      const listener = (event: StorageEvent) => {
        if (event.key === null || [STAFF_RESPONSE_SIGNAL_KEY, STAFF_RESPONSE_EPOCH_KEY, STAFF_RESPONSE_STORAGE_KEY].includes(event.key)) invalidate();
      };
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
  };
}

/** Web Locks order commits and UI callbacks. IndexedDB alone is the authority
 * for generation checks, even when notifications never arrive. */
export function createStaffResponseSession(runtime: ResponsePersistenceRuntime, callbacks: Callbacks) {
  let closed = false;
  let revision = 0;
  let epoch: string | undefined;
  let controller = new AbortController();
  const deletions = new Set<AbortController>();
  const permissions: Partial<Record<"save" | "restore", number>> = {};
  const report = (result: Result) => { if (!closed) callbacks.result(result); };
  const reset = () => {
    controller.abort(); controller = new AbortController();
    revision += 1; epoch = undefined;
    delete permissions.save; delete permissions.restore;
    if (!closed) callbacks.reset();
  };
  const freshEpoch = () => {
    const value = runtime.newEpoch();
    if (!epochPattern.test(value)) throw new Error("Invalid generated response epoch");
    return value;
  };
  const ensureEpoch = (state: ResponseState) => {
    if (state.epoch === null) { state.epoch = freshEpoch(); state.snapshot = null; }
    if (!epochPattern.test(state.epoch)) throw new Error("Invalid response epoch");
    return state.epoch;
  };
  const publish = () => { try { runtime.notify(); } catch { /* Never used to authorize writes. */ } };
  const initialize = async () => {
    if (!runtime.lock) {
      try { runtime.cleanupLegacy(); } catch { /* No persistence/deletion guarantee is claimed. */ }
      report({ status: "noLock" }); return;
    }
    const ticket = revision; const signal = controller.signal;
    try {
      await runtime.lock(async () => {
        if (closed || ticket !== revision) return;
        runtime.cleanupLegacy();
        const current = await runtime.transaction(ensureEpoch, signal);
        if (!closed && ticket === revision) { epoch = current; callbacks.ready(revision); }
      });
    } catch { if (!closed && ticket === revision) report({ status: "unavailable" }); }
  };
  const unsubscribe = runtime.subscribe(() => { reset(); void initialize(); });

  return {
    initialize,
    authorize(action: "save" | "restore", granted: boolean, renderedRevision: number | null): boolean {
      if (!granted) { delete permissions[action]; return false; }
      if (closed || epoch === undefined || renderedRevision !== revision || !runtime.lock) return false;
      permissions[action] = revision; return true;
    },
    async persist(action: "save" | "restore", context: string, answers: StaffAnswers, questionIds: readonly string[], consent: boolean, renderedRevision: number | null) {
      if (closed || !consent) return;
      if (!runtime.lock) { report({ status: "noLock" }); return; }
      if (permissions[action] !== revision || renderedRevision !== revision || epoch === undefined) return;
      const ticket = revision; const startedEpoch = epoch; const signal = controller.signal;
      const snapshot = { ...answers }; const ids = [...questionIds];
      try {
        const hash = await runtime.hash(context);
        await runtime.lock(async () => {
          if (closed || ticket !== revision) return;
          runtime.cleanupLegacy();
          const outcome = await runtime.transaction((state) => {
            const current = ensureEpoch(state);
            if (current !== startedEpoch) return { current, result: null };
            // Transient codec adapter: never browser localStorage.
            const adapter = {
              getItem: () => state.snapshot,
              setItem: (_key: string, value: string) => { state.snapshot = value; },
              removeItem: () => { state.snapshot = null; },
            };
            const result: Result = action === "save"
              ? { status: saveStaffResponses(hash, snapshot, ids, true, adapter, current) ? "saved" : "unavailable" }
              : restoreStaffResponses(hash, ids, adapter, current);
            return { current, result };
          }, signal);
          if (closed || ticket !== revision) return;
          if (outcome.result === null) {
            reset(); epoch = outcome.current; callbacks.ready(revision);
          } else {
            report(outcome.result);
            if (["saved", "rejected"].includes(outcome.result.status)) publish();
          }
        });
      } catch { if (!closed && ticket === revision) report({ status: "unavailable" }); }
    },
    async deleteAll() {
      if (closed) return;
      reset();
      // A notification can revoke save/restore consent, but cannot cancel an
      // explicit deletion. Only closing this session cancels its deletion work.
      const deletion = new AbortController();
      deletions.add(deletion);
      const signal = deletion.signal;
      const remove = async () => {
        let legacyClean = true;
        try { runtime.cleanupLegacy(); } catch { legacyClean = false; }
        const current = await runtime.transaction((state) => {
          state.epoch = freshEpoch(); state.snapshot = null; return state.epoch;
        }, signal);
        if (closed) return;
        reset();
        if (legacyClean && runtime.lock) { epoch = current; callbacks.ready(revision); }
        publish();
        report({ status: !runtime.lock ? "noLockDelete" : legacyClean ? "deleted" : "deleteFailed" });
      };
      try {
        if (runtime.lock) await runtime.lock(remove);
        else await remove();
      } catch { report({ status: runtime.lock ? "deleteFailed" : "noLockDelete" }); }
      finally { deletions.delete(deletion); }
    },
    close() {
      closed = true; revision += 1; controller.abort();
      deletions.forEach((deletion) => deletion.abort()); deletions.clear(); unsubscribe();
    },
  };
}
