import { sanitizeDietarySettings, type DietarySettings } from "./dietarySettingsStorage";

// Separate from staffResponseDatabase. No images, API responses or personal IDs.
const DATABASE = "allergy_bridge_dietary_settings_v2";
const STORE = "state";
export type DietaryRecord = { revision: number; settings: DietarySettings };

/** IndexedDB readwrite transactions provide the cross-renderer read/modify/write
 * boundary that localStorage caches (even behind Web Locks) cannot provide.
 * Once this row exists, legacy localStorage snapshots are never imported again.
 */
export function dietaryTransaction<T>(
  seed: () => DietarySettings,
  operation: (current: DietaryRecord) => { next?: DietaryRecord; result: T },
): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { transaction?.abort(); } catch { /* already finished */ }
      db?.close();
      reject(new Error("dietary_storage_transaction_failed"));
    };
    const timer = setTimeout(fail, 5000);
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = fail;
      request.onblocked = fail;
      request.onsuccess = () => {
        db = request.result;
        if (settled) { db.close(); return; }
        try {
          transaction = db.transaction(STORE, "readwrite");
          const store = transaction.objectStore(STORE);
          let value: T;
          let completed = false;
          transaction.onerror = fail;
          transaction.onabort = fail;
          transaction.oncomplete = () => {
            if (settled) return;
            if (!completed) { fail(); return; }
            settled = true;
            clearTimeout(timer);
            db?.close();
            resolve(value);
          };
          const read = store.get("profile");
          read.onerror = fail;
          read.onsuccess = () => {
            try {
              const raw: unknown = read.result;
              let current: DietaryRecord;
              if (raw === undefined) current = { revision: 0, settings: seed() };
              else {
                if (raw === null || typeof raw !== "object" || !("revision" in raw)
                  || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0
                  || (raw.revision as number) >= Number.MAX_SAFE_INTEGER || !("settings" in raw)) {
                  throw new Error("invalid_dietary_record");
                }
                current = { revision: raw.revision as number, settings: sanitizeDietarySettings(raw.settings) };
              }
              const outcome = operation(current);
              value = outcome.result;
              completed = true;
              // Also persist an empty row: deleting settings must never enable
              // a future re-import of an obsolete localStorage profile.
              if (outcome.next || raw === undefined) store.put(outcome.next ?? current, "profile");
            } catch { fail(); }
          };
        } catch { fail(); }
      };
    } catch { fail(); }
  });
}
