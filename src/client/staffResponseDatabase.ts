import { z } from "zod";

export const RESPONSE_DATABASE = "allergy_bridge_staff_responses_v3";
export const RESPONSE_OBJECT_STORE = "records";
export const RESPONSE_RECORD = "current";
const StateSchema = z.object({
  epoch: z.string().uuid().nullable(),
  snapshot: z.string().max(8192).nullable(),
}).strict();
export type ResponseState = z.infer<typeof StateSchema>;
export type ResponseTransaction = <T>(task: (state: ResponseState) => T, signal?: AbortSignal) => Promise<T>;

/** Read, generation check and write share one readwrite transaction. No await in task.
 * Resolve only after COMMIT, never at the individual request's success event. */
export const responseTransaction: ResponseTransaction = (task, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
  let settled = false;
  const open = indexedDB.open(RESPONSE_DATABASE, 1);
  const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
  open.onupgradeneeded = () => {
    try { open.result.createObjectStore(RESPONSE_OBJECT_STORE); }
    catch (error) {
      fail(error);
      try { open.transaction?.abort(); } catch { /* Already aborted. */ }
    }
  };
  open.onblocked = () => fail(new Error("Response database blocked"));
  open.onerror = () => fail(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (settled || signal?.aborted) { db.close(); fail(new DOMException("Cancelled", "AbortError")); return; }
    db.onversionchange = () => db.close();
    let tx: IDBTransaction;
    try { tx = db.transaction(RESPONSE_OBJECT_STORE, "readwrite"); }
    catch (error) { db.close(); fail(error); return; }
    const abort = () => { try { tx.abort(); } catch { /* Already finished. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { signal?.removeEventListener("abort", abort); db.close(); };
    let result: ReturnType<typeof task>;
    let taskError: unknown;
    tx.onabort = () => { cleanup(); fail(taskError ?? tx.error ?? new DOMException("Cancelled", "AbortError")); };
    tx.onerror = () => { /* onabort handles errors, including quota and put failures. */ };
    tx.oncomplete = () => {
      cleanup();
      if (taskError !== undefined) { fail(taskError); return; }
      if (!settled) { settled = true; resolve(result); }
    };
    try {
      const store = tx.objectStore(RESPONSE_OBJECT_STORE);
      const request = store.get(RESPONSE_RECORD);
      request.onsuccess = () => {
        try {
          if (signal?.aborted) { abort(); return; }
          const state = request.result === undefined ? { epoch: null, snapshot: null } : StateSchema.parse(request.result);
          result = task(state);
          store.put(StateSchema.parse(state), RESPONSE_RECORD);
        } catch (error) { taskError = error; abort(); }
      };
    } catch (error) { taskError = error; abort(); }
  };
});
