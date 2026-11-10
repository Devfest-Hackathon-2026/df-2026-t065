/* SYNTHETIC TEST DATA. Independent native IndexedDB probes; never logs answers. */
import assert from "node:assert/strict";
export const readStateExpression = `new Promise((resolve, reject) => {
  const open = indexedDB.open('allergy_bridge_staff_responses_v3', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('records');
  open.onerror = () => reject(new Error('probe open failed'));
  open.onsuccess = () => {
    const db = open.result; const tx = db.transaction('records', 'readonly');
    const get = tx.objectStore('records').get('current');
    tx.oncomplete = () => { db.close(); resolve(get.result ?? {epoch:null,snapshot:null}); };
    tx.onabort = () => { db.close(); reject(new Error('probe aborted')); };
  };
})`;
export const readState = (page) => page.eval(readStateExpression);
export const readSnapshot = async (page) => (await readState(page)).snapshot;
export async function assertEmpty(page) {
  const state = await readState(page);
  assert(state.snapshot === null, "deleted answers absent from IndexedDB");
  assert(typeof state.epoch === "string", "non-sensitive generation tombstone retained");
  assert(await page.eval("localStorage.getItem('allergy_bridge_staff_responses') === null"), "no legacy answers remain");
}
export async function writeRawSnapshot(page, raw) {
  await page.eval(`new Promise((resolve,reject) => {
    const open = indexedDB.open('allergy_bridge_staff_responses_v3',1);
    open.onsuccess = () => { const db=open.result; const tx=db.transaction('records','readwrite'); const store=tx.objectStore('records'); const get=store.get('current');
      get.onsuccess=()=>store.put({...get.result,snapshot:${JSON.stringify(raw)}},'current');
      tx.oncomplete=()=>{db.close();resolve()}; tx.onabort=()=>{db.close();reject(new Error('fixture write aborted'))};
    }; open.onerror=()=>reject(new Error('fixture open failed'));
  })`);
}
