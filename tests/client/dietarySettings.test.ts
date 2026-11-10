import { describe, expect, it } from "vitest";
import {
  applyPresetToggle,
  clearDietarySettings,
  loadDietarySettings,
  normalizeActivePresets,
  normalizeSelectedConditions,
  sanitizeDietarySettings,
  saveDietarySettings,
  saveDietarySettingsResult,
  clearDietarySettingsResult,
  type StorageLike,
} from "@/client/dietarySettingsStorage";

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("dietarySettingsStorage", () => {
  it("normalizes and deduplicates conditions and presets in canonical order", () => {
    const rawConds = ["pork", "meat", "pork"] as const;
    expect(normalizeSelectedConditions(rawConds)).toEqual(["meat", "pork"]);

    const rawPresets = ["halal_check", "vegan", "vegan"] as const;
    expect(normalizeActivePresets(rawPresets)).toEqual(["vegan", "halal_check"]);
  });

  it("sanitizes invalid or malicious payload safely", () => {
    expect(sanitizeDietarySettings(null)).toEqual({
      activePresets: [],
      selectedConditions: [],
    });
    expect(
      sanitizeDietarySettings({
        activePresets: ["invalid_preset"],
        selectedConditions: ["invalid_code"],
      }),
    ).toEqual({
      activePresets: [],
      selectedConditions: [],
    });
  });

  it("loads and saves dietary settings via storage abstraction", () => {
    const storage = createMemoryStorage();
    expect(loadDietarySettings(storage)).toEqual({
      activePresets: [],
      selectedConditions: [],
    });

    const saved = saveDietarySettings(
      {
        activePresets: ["vegan"],
        selectedConditions: ["meat", "egg", "dairy"],
      },
      storage,
    );
    expect(saved.activePresets).toEqual(["vegan"]);
    expect(loadDietarySettings(storage)).toEqual(saved);

    const cleared = clearDietarySettings(storage);
    expect(cleared).toEqual({
      activePresets: [],
      selectedConditions: [],
    });
    expect(loadDietarySettings(storage)).toEqual(cleared);
  });

  it("applies preset toggling and expands default conditions", () => {
    const initial = {
      activePresets: [],
      selectedConditions: [],
    };

    const withHalal = applyPresetToggle(initial, "halal_check");
    expect(withHalal.activePresets).toContain("halal_check");
    expect(withHalal.selectedConditions).toContain("pork");
    expect(withHalal.selectedConditions).toContain("alcohol_seasoning");

    // Toggling preset off keeps custom condition selections editable
    const toggleOff = applyPresetToggle(withHalal, "halal_check");
    expect(toggleOff.activePresets).not.toContain("halal_check");
    expect(toggleOff.selectedConditions).toContain("pork");
  });

  // MAJOR-2: Deletion guarantees & error isolation
  it("reports failure when removeItem throws SecurityError / AccessDenied", () => {
    const failingStorage: StorageLike = {
      getItem: () => "{}",
      setItem: () => {},
      removeItem: () => {
        throw new Error("SecurityError: Access is denied for this document");
      },
    };

    const result = clearDietarySettingsResult(failingStorage);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("remove_failed");
  });

  it("reports failure when setItem throws QuotaExceededError", () => {
    const quotaExceededStorage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };

    const result = saveDietarySettingsResult(
      { activePresets: ["vegan"], selectedConditions: ["meat"] },
      quotaExceededStorage,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("write_failed");
  });

  it("prevents resurrected profiles using deletion tombstone", () => {
    const storage = createMemoryStorage();
    saveDietarySettings({ activePresets: ["vegan"], selectedConditions: ["meat"] }, storage);
    const clearResult = clearDietarySettingsResult(storage);
    expect(clearResult.ok).toBe(true);

    expect(loadDietarySettings(storage)).toEqual({
      activePresets: [],
      selectedConditions: [],
    });
  });
});
