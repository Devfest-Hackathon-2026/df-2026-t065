import { describe, expect, it } from "vitest";
import {
  updateDietarySettingsResult as update, eraseDietarySettingsResult as erase,
  loadDietarySettings as load, clearDietarySettingsResult as clear,
  saveDietarySettingsResult as save, DIETARY_SETTINGS_STORAGE_KEY as K,
  DIETARY_SETTINGS_CLEARED_AT_KEY as T, type DietarySettings, type DietarySettingsLock, type StorageLike,
} from "@/client/dietarySettingsStorage";
const empty: DietarySettings = { activePresets: [], selectedConditions: [] };
const old: DietarySettings = { activePresets: ["halal_check"], selectedConditions: ["pork"] };
function fixture() {
  const values = new Map<string, string>();
  const storage: StorageLike = {
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const lock: DietarySettingsLock = task => {
    const result = tail.then(task); tail = result.catch(() => {}); return result;
  };
  return { storage, values, lock };
}
const honey = (current: DietarySettings): DietarySettings => ({ ...current, selectedConditions: [...current.selectedConditions, "honey"] });
describe("SYNTHETIC TEST DATA: dietary deletion and concurrent user intents", () => {
  it.each(["missing", "delayed"])("%s events: a stale tab edits the latest state, then reload cannot resurrect it", async () => {
    const { storage, lock, values } = fixture(); save(old, storage);
    const stale = load(storage);
    expect((await erase(storage, lock)).ok).toBe(true);
    const result = await update(honey, stale, storage, lock);
    expect(result.ok).toBe(true);
    expect(result.settings).toEqual({ activePresets: [], selectedConditions: ["honey"] });
    expect(load(storage)).toEqual(result.settings);
    expect(values.has(T)).toBe(true);
  });
  it("serializes two tabs' simultaneous updates without losing either explicit selection", async () => {
    const { storage, lock } = fixture();
    await Promise.all([
      update(honey, empty, storage, lock),
      update(c => ({ ...c, selectedConditions: [...c.selectedConditions, "pork"] }), empty, storage, lock),
    ]);
    expect(load(storage).selectedConditions).toEqual(["pork", "honey"]);
  });
  it.each(["update-delete", "delete-update"])("serializes %s: no pre-delete condition survives", async order => {
    const { storage, lock } = fixture(); save(old, storage);
    if (order === "update-delete") await Promise.all([update(honey, old, storage, lock), erase(storage, lock)]);
    else await Promise.all([erase(storage, lock), update(honey, old, storage, lock)]);
    expect(load(storage).selectedConditions).toEqual(order === "update-delete" ? [] : ["honey"]);
    expect(load(storage).activePresets).toEqual([]);
  });
  it("does not claim erasure when removeItem fails, and the deletion barrier blocks reload", async () => {
    const { storage, lock } = fixture(); save(old, storage);
    storage.removeItem = () => { throw new Error("SYNTHETIC SecurityError"); };
    expect((await erase(storage, lock)).ok).toBe(false);
    expect(load(storage)).toEqual(empty);
  });
  it("does not claim erasure when the durable barrier cannot be written", async () => {
    const { storage, lock } = fixture(); save(old, storage);
    storage.setItem = () => { throw new Error("SYNTHETIC quota"); };
    expect(await erase(storage, lock)).toMatchObject({ ok: false, error: "tombstone_failed" });
    expect(load(storage)).toEqual(old);
  });
  it("keeps unrelated and allergy keys", async () => {
    const { storage, lock, values } = fixture();
    values.set("other", "SYNTHETIC"); values.set("allergy_bridge_settings_v1", "SYNTHETIC");
    await erase(storage, lock); expect(values.get("other")).toBe("SYNTHETIC");
    expect(values.get("allergy_bridge_settings_v1")).toBe("SYNTHETIC");
  });
  it("legacy undated or full snapshots cannot grant renewed consent after deletion", () => {
    const { storage, values } = fixture(); save(old, storage); clear(storage);
    expect(save(old, storage)).toMatchObject({ ok: false, error: "conflict" });
    values.set(K, JSON.stringify(old)); expect(load(storage)).toEqual(empty);
  });
  it("fails closed on inaccessible tombstone reads", () => {
    const { storage } = fixture(); save(old, storage);
    const get = storage.getItem; storage.getItem = k => { if (k === T) throw Error("SYNTHETIC"); return get(k); };
    expect(load(storage)).toEqual(empty);
  });
  it("a legacy writer interrupted by delete cannot revive a profile even if its setItem completes last", () => {
    const { storage } = fixture(); save(old, storage); const set = storage.setItem; let once = true;
    storage.setItem = (k, v) => { if (k === K && once) { once = false; clear(storage); } set(k, v); };
    save(old, storage); expect(load(storage)).toEqual(empty);
  });
  it("unavailable storage, failed writes, or unavailable locks are never reported as durable success", async () => {
    expect(await update(honey, empty, null, null)).toMatchObject({ ok: false, error: "storage_unavailable" });
    const { storage, lock } = fixture();
    expect(await update(honey, empty, storage, null)).toMatchObject({ ok: false, error: "locking_unavailable" });
    storage.setItem = () => { throw Error("SYNTHETIC"); };
    expect(await update(honey, empty, storage, lock)).toMatchObject({ ok: false, error: "write_failed" });
    expect((await erase(null, null)).ok).toBe(false);
  });
  it("an obsolete v1 client removing its tombstone and writing an old payload cannot bypass the v2 deletion barrier", async () => {
    const { storage, lock } = fixture(); save(old, storage);
    expect((await erase(storage, lock)).ok).toBe(true);
    storage.setItem(K, JSON.stringify({ ...old, savedAt: Date.now() + 1000 }));
    storage.removeItem(T); // exact pre-fix save path in an already loaded tab
    expect(load(storage)).toEqual(empty);
    expect((await update(honey, old, storage, lock)).settings).toEqual({ activePresets: [], selectedConditions: ["honey"] });
    expect(load(storage).selectedConditions).toEqual(["honey"]);
  });
  it("a later legacy delete also invalidates a modern profile", async () => {
    const { storage, lock } = fixture(); await erase(storage, lock);
    await update(() => old, empty, storage, lock);
    storage.removeItem(K); storage.setItem(T, String(Date.now()));
    storage.setItem(K, JSON.stringify({ ...old, savedAt: Date.now() + 1000 }));
    expect(load(storage)).toEqual(empty);
  });
  it("normal save, update, clear and new explicit consent remain usable", async () => {
    const { storage, lock } = fixture();
    expect((await update(() => old, empty, storage, lock)).ok).toBe(true);
    expect(load(storage)).toEqual(old);
    expect((await erase(storage, lock)).ok).toBe(true);
    expect(load(storage)).toEqual(empty);
    expect((await update(honey, empty, storage, lock)).ok).toBe(true);
    expect(load(storage).selectedConditions).toEqual(["honey"]);
  });
});
