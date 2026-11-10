import { describe, expect, it } from "vitest";
import { DietarySettingsCoordinator } from "@/client/dietarySettingsCoordinator";
import { type DietarySettings } from "@/client/dietarySettingsStorage";
const empty: DietarySettings = { activePresets: [], selectedConditions: [] };
const pork: DietarySettings = { activePresets: [], selectedConditions: ["pork"] };
const honey = (s: DietarySettings): DietarySettings => ({ ...s, selectedConditions: [...s.selectedConditions, "honey"] });
describe("SYNTHETIC TEST DATA: dietary UI result generations", () => {
  it.each([true, false])("rejects an old save success=%s after deletion notification, even without revision", ok => {
    const state = new DietarySettingsCoordinator(pork), token = state.begin();
    expect(state.synchronize({ revision: 2, settings: empty })).toEqual(empty);
    expect(state.complete(token, { ok, settings: honey(pork) }, honey)).toBeNull();
  });
  it.each([true, false])("rejects an old delete success=%s after a newer update", ok => {
    const state = new DietarySettingsCoordinator(empty), token = state.begin();
    state.synchronize({ revision: 3, settings: pork });
    expect(state.complete(token, { ok, settings: empty }, () => empty)).toBeNull();
  });
  it("rejects initial restoration after user intent or a newer synchronization", () => {
    const state = new DietarySettingsCoordinator(empty), initial = state.checkpoint();
    state.begin(); expect(state.restore({ revision: 0, settings: pork }, initial)).toBeNull();
    const later = state.checkpoint(); state.synchronize({ revision: 2, settings: empty });
    expect(state.restore({ revision: 1, settings: pork }, later)).toBeNull();
  });
  it("temporary mode uses only the explicit intent on current state, ignoring a stale failure snapshot", () => {
    const state = new DietarySettingsCoordinator(empty);
    expect(state.complete(state.begin(), { ok: false, settings: pork }, honey)).toEqual(honey(empty));
    const remove = (s: DietarySettings): DietarySettings => ({ ...s, selectedConditions: s.selectedConditions.filter(c => c !== "honey") });
    expect(state.complete(state.begin(), { ok: false, settings: pork }, remove)).toEqual(empty);
    expect(state.complete(state.begin(), { ok: false, settings: pork }, () => empty)).toEqual(empty);
  });
  it("rejects missing success revisions, old revisions, duplicate completions and disposed operations", () => {
    const state = new DietarySettingsCoordinator(empty); state.synchronize({ revision: 4, settings: empty });
    expect(state.complete(state.begin(), { ok: true, settings: pork }, honey)).toBeNull();
    expect(state.complete(state.begin(), { ok: true, revision: 3, settings: pork }, honey)).toBeNull();
    const token = state.begin(); expect(state.complete(token, { ok: true, revision: 5, settings: pork }, honey)).toEqual(pork);
    expect(state.complete(token, { ok: true, revision: 5, settings: pork }, honey)).toBeNull();
    const disposed = state.begin(); state.invalidate();
    expect(state.complete(disposed, { ok: false, settings: pork }, honey)).toBeNull();
  });
});
