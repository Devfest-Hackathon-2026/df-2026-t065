import { afterEach, describe, expect, it, vi } from "vitest";
import { updateDietarySettingsResult, type DietarySettings, type StorageLike } from "@/client/dietarySettingsStorage";
const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/client/dietarySettingsDatabase", () => ({ dietaryTransaction: database.transaction }));
const empty: DietarySettings = { activePresets: [], selectedConditions: [] };
const old: DietarySettings = { activePresets: ["halal_check"], selectedConditions: ["pork"] };
const storage: StorageLike = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const honey = (current: DietarySettings): DietarySettings => ({ ...current, selectedConditions: [...current.selectedConditions, "honey"] });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });
describe("SYNTHETIC TEST DATA: late canonical failure and lock acquisition deadline", () => {
  it.each(["abort", "put failure"])("%s after observing a newer deletion cannot return the old profile", async () => {
    vi.stubGlobal("window", {});
    database.transaction.mockImplementation((_seed, operation) => {
      operation({ revision: 2, settings: empty });
      return Promise.reject(new Error("SYNTHETIC canonical failure"));
    });
    const result = await updateDietarySettingsResult(honey, old, storage, async task => task());
    expect(result.ok).toBe(false);
    expect(result.settings.selectedConditions).not.toContain("pork");
    expect(result).toMatchObject({ revision: 2, settings: empty });
  });
  it("bounds acquisition, reports failure, and refuses a late grant even if a lock provider ignores abort", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", {});
    database.transaction.mockResolvedValue({ ok: true, revision: 3, settings: old });
    let grant: (() => unknown) | undefined;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("navigator", { locks: { request: (...args: unknown[]) => {
      grant = args.at(-1) as () => unknown;
      signal = (args[1] as LockOptions)?.signal;
      return new Promise(() => {});
    } } });
    let result: Awaited<ReturnType<typeof updateDietarySettingsResult>> | undefined;
    const pending = updateDietarySettingsResult(honey, old, storage).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(5001);
    expect(result, "lock deadline must settle the operation as failure").toMatchObject({ ok: false });
    expect(signal?.aborted).toBe(true);
    expect(() => grant?.()).toThrow();
    expect(database.transaction).not.toHaveBeenCalled();
    await pending;
  });
  it("refuses an elapsed deadline even when the timer callback has been delayed", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", {});
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    database.transaction.mockResolvedValue({ ok: true, revision: 3, settings: old });
    let grant: (() => void) | undefined;
    vi.stubGlobal("navigator", { locks: { request: (...args: unknown[]) => new Promise((resolve, reject) => {
      grant = () => { void Promise.resolve().then(args.at(-1) as () => unknown).then(resolve, reject); };
    }) } });
    const pending = updateDietarySettingsResult(honey, old, storage);
    // A busy/suspended event loop has not delivered its timeout task yet.
    clock.mockReturnValue(5001);
    grant?.();
    expect(await pending).toMatchObject({ ok: false });
    expect(database.transaction).not.toHaveBeenCalled();
  });

});
