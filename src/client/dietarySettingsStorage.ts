import { z } from "zod";
import { dietaryTransaction, type DietaryRecord } from "./dietarySettingsDatabase";
import {
  DIETARY_CONDITION_CODES,
  DIETARY_PRESET_IDS,
  DIETARY_PRESETS,
  DietaryConditionCodeSchema,
  DietaryPresetIdSchema,
  type DietaryConditionCode,
  type DietaryPresetId,
} from "@/contracts/dietary";

export const DIETARY_SETTINGS_STORAGE_KEY = "allergy_bridge_dietary_restrictions_v1";
export const DIETARY_SETTINGS_CLEARED_AT_KEY = "allergy_bridge_dietary_restrictions_cleared_at_v1";
// Obsolete clients delete the v1 tombstone on save. Keep an authoritative
// barrier in a separate namespace that those clients never remove.
export const DIETARY_SETTINGS_DELETION_GENERATION_KEY = "allergy_bridge_dietary_restrictions_deletion_generation_v2";

export type DietarySettings = {
  readonly activePresets: DietaryPresetId[];
  readonly selectedConditions: DietaryConditionCode[];
};

export const DEFAULT_DIETARY_SETTINGS: Readonly<DietarySettings> = {
  activePresets: [],
  selectedConditions: [],
};

const StoredDietarySettingsSchema = z
  .object({
    activePresets: z.array(DietaryPresetIdSchema).max(DIETARY_PRESET_IDS.length),
    selectedConditions: z.array(DietaryConditionCodeSchema).max(DIETARY_CONDITION_CODES.length),
    savedAt: z.number().finite().optional(),
    deletionGeneration: z.string().optional(),
  })
  .strict();

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getDefaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDeletionGeneration(storage: StorageLike): string | null {
  const modern = storage.getItem(DIETARY_SETTINGS_DELETION_GENERATION_KEY);
  const legacy = storage.getItem(DIETARY_SETTINGS_CLEARED_AT_KEY);
  // Include later legacy deletions too. Removing the legacy marker never
  // removes the modern barrier or grants consent to an unversioned payload.
  return modern === null ? legacy : JSON.stringify([modern, legacy]);
}

/**
 * Deduplicates and orders selected conditions according to the canonical DIETARY_CONDITION_CODES order.
 */
export function normalizeSelectedConditions(
  conditions: readonly DietaryConditionCode[],
): DietaryConditionCode[] {
  const selectedSet = new Set(conditions);
  return DIETARY_CONDITION_CODES.filter((code) => selectedSet.has(code));
}

/**
 * Normalizes preset IDs, deduplicated in canonical DIETARY_PRESET_IDS order.
 */
export function normalizeActivePresets(presets: readonly DietaryPresetId[]): DietaryPresetId[] {
  const selectedSet = new Set(presets);
  return DIETARY_PRESET_IDS.filter((id) => selectedSet.has(id));
}

/**
 * Validates and normalizes arbitrary input into safe DietarySettings.
 */
export function sanitizeDietarySettings(raw: unknown): DietarySettings {
  const parsed = StoredDietarySettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      activePresets: [],
      selectedConditions: [],
    };
  }
  return {
    activePresets: normalizeActivePresets(parsed.data.activePresets),
    selectedConditions: normalizeSelectedConditions(parsed.data.selectedConditions),
  };
}

export type LoadDietarySettingsResult = {
  readonly settings: DietarySettings;
  readonly isClearedTombstone: boolean;
};

export function loadDietarySettings(
  storage: StorageLike | null = getDefaultStorage(),
): DietarySettings {
  if (!storage) {
    return { ...DEFAULT_DIETARY_SETTINGS };
  }
  try {
    const rawJson = storage.getItem(DIETARY_SETTINGS_STORAGE_KEY);
    if (!rawJson) {
      return { ...DEFAULT_DIETARY_SETTINGS };
    }
    const parsedJson: unknown = JSON.parse(rawJson);
    const parsed = StoredDietarySettingsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { ...DEFAULT_DIETARY_SETTINGS };
    }

    // A deletion generation is authoritative, including for legacy undated payloads.
    // Reading it must succeed; inability to establish consent fails closed.
    const generation = readDeletionGeneration(storage);
    if (generation !== null && parsed.data.deletionGeneration !== generation) {
      return { ...DEFAULT_DIETARY_SETTINGS };
    }

    return sanitizeDietarySettings(parsedJson);
  } catch {
    return { ...DEFAULT_DIETARY_SETTINGS };
  }
}

export type SaveDietarySettingsResult = {
  readonly ok: boolean;
  readonly revision?: number;
  readonly settings: DietarySettings;
  readonly error?: "storage_unavailable" | "write_failed" | "conflict" | "locking_unavailable";
};

export function saveDietarySettingsResult(
  settings: DietarySettings,
  storage: StorageLike | null = getDefaultStorage(),
): SaveDietarySettingsResult {
  const sanitized = sanitizeDietarySettings(settings);
  if (!storage) {
    return { ok: false, settings: sanitized, error: "storage_unavailable" };
  }
  try {
    // This compatibility entry point cannot prove that a snapshot was selected
    // after deletion. Never grant it consent to overwrite a deletion generation.
    if (readDeletionGeneration(storage) !== null) {
      return { ok: false, settings: loadDietarySettings(storage), error: "conflict" };
    }
    const payload = { ...sanitized, savedAt: Date.now() };
    storage.setItem(DIETARY_SETTINGS_STORAGE_KEY, JSON.stringify(payload));

    return { ok: true, settings: sanitized };
  } catch {
    return { ok: false, settings: sanitized, error: "write_failed" };
  }
}

export function saveDietarySettings(
  settings: DietarySettings,
  storage: StorageLike | null = getDefaultStorage(),
): DietarySettings {
  return saveDietarySettingsResult(settings, storage).settings;
}

export type ClearDietarySettingsResult = {
  readonly ok: boolean;
  readonly revision?: number;
  readonly settings: DietarySettings;
  readonly error?: "storage_unavailable" | "remove_failed" | "tombstone_failed" | "locking_unavailable";
};

export function clearDietarySettingsResult(
  storage: StorageLike | null = getDefaultStorage(),
): ClearDietarySettingsResult {
  if (!storage) {
    return { ok: false, settings: { ...DEFAULT_DIETARY_SETTINGS }, error: "storage_unavailable" };
  }
  try {
    // Commit the deletion barrier FIRST. A failed removal can leave bytes on
    // disk, but readers must still refuse them. Report either failure honestly.
    try {
      const generation = crypto.randomUUID();
      storage.setItem(DIETARY_SETTINGS_DELETION_GENERATION_KEY, generation);
      storage.setItem(DIETARY_SETTINGS_CLEARED_AT_KEY, generation);
    } catch {
      return { ok: false, settings: { ...DEFAULT_DIETARY_SETTINGS }, error: "tombstone_failed" };
    }
    storage.removeItem(DIETARY_SETTINGS_STORAGE_KEY);

    return { ok: true, settings: { ...DEFAULT_DIETARY_SETTINGS } };
  } catch {
    return { ok: false, settings: { ...DEFAULT_DIETARY_SETTINGS }, error: "remove_failed" };
  }
}

export function clearDietarySettings(
  storage: StorageLike | null = getDefaultStorage(),
): DietarySettings {
  return clearDietarySettingsResult(storage).settings;
}

export async function readDietarySettingsResult(
  storage: StorageLike | null = getDefaultStorage(),
): Promise<{ settings: DietarySettings; revision: number }> {
  if (!storage) return { settings: { ...DEFAULT_DIETARY_SETTINGS }, revision: -1 };
  try {
    return await dietaryTransaction(() => loadDietarySettings(storage), current => ({ result: current }));
  } catch {
    // Never restore a legacy profile when the authoritative store is inaccessible.
    return { settings: { ...DEFAULT_DIETARY_SETTINGS }, revision: -1 };
  }
}

/** Browser writes/deletes share one origin-wide lock, never relying on events.
 * A mutation is an explicit user intent applied to the latest persisted state,
 * not a stale full-profile snapshot. Missing Web Locks => no persistence promise.
 */
export type DietarySettingsLock = <T>(task: () => T) => Promise<T>;
function browserLock(): DietarySettingsLock | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  return task => new Promise((resolve, reject) => {
    const controller = new AbortController();
    const deadline = performance.now() + 5000;
    let expired = false;
    // The acquisition deadline starts before request(), independently of the
    // transaction deadline. Aborting a queued request prevents ghost writes.
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(new Error("dietary_lock_acquisition_expired"));
    }, 5000);
    try {
      const request = navigator.locks.request("allergy-bridge-dietary-settings", { signal: controller.signal }, () => {
        if (expired || performance.now() >= deadline) {
          expired = true;
          controller.abort();
          throw new Error("dietary_lock_acquisition_expired");
        }
        clearTimeout(timer);
        return task();
      });
      // Always consume a late rejection, including after the deadline fired.
      void request.then(resolve, reject).finally(() => clearTimeout(timer));
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

export async function updateDietarySettingsResult(
  update: (current: DietarySettings) => DietarySettings,
  memory: DietarySettings,
  storage: StorageLike | null = getDefaultStorage(),
  lock: DietarySettingsLock | null = browserLock(),
): Promise<SaveDietarySettingsResult> {
  // Temporary UI intents are applied by the generation coordinator to its
  // current state. Never return a pre-lock full-memory fallback.
  void memory; // Kept for compatibility with existing callers.
  const empty = { ...DEFAULT_DIETARY_SETTINGS };
  if (!storage) return { ok: false, settings: empty, error: "storage_unavailable" };
  if (!lock) return { ok: false, settings: empty, error: "locking_unavailable" };
  let observed: DietaryRecord | undefined;
  try {
    return await lock(() => {
      if (typeof window !== "undefined") {
        return dietaryTransaction<SaveDietarySettingsResult>(() => loadDietarySettings(storage), current => {
          observed = current;
          const settings = sanitizeDietarySettings(update(current.settings));
          const revision = current.revision + 1;
          try {
            const generation = readDeletionGeneration(storage);
            storage.setItem(DIETARY_SETTINGS_STORAGE_KEY, JSON.stringify({
              ...settings, savedAt: Date.now(),
              ...(generation === null ? {} : { deletionGeneration: generation }),
            }));
          } catch {
            return { result: { ok: false, settings: current.settings, revision: current.revision, error: "write_failed" } };
          }
          return { next: { revision, settings }, result: { ok: true, settings, revision } };
        });
      }
      // Injectable synchronous storage backend for Node-only contract tests.
      // Do not interpret a storage read error as a new empty, consented profile.
      const generation = readDeletionGeneration(storage);
      storage.getItem(DIETARY_SETTINGS_STORAGE_KEY);
      const settings = sanitizeDietarySettings(update(loadDietarySettings(storage)));
      storage.setItem(DIETARY_SETTINGS_STORAGE_KEY, JSON.stringify({
        ...settings, savedAt: Date.now(),
        ...(generation === null ? {} : { deletionGeneration: generation }),
      }));
      // Also fail closed if an obsolete/uncooperative writer deletes mid-write.
      if (readDeletionGeneration(storage) !== generation) {
        return { ok: false, settings: loadDietarySettings(storage), error: "conflict" as const };
      }
      return { ok: true, settings };
    });
  } catch {
    return { ok: false, settings: observed?.settings ?? empty,
      ...(observed ? { revision: observed.revision } : {}), error: "write_failed" };
  }
}

export async function eraseDietarySettingsResult(
  storage: StorageLike | null = getDefaultStorage(),
  lock: DietarySettingsLock | null = browserLock(),
): Promise<ClearDietarySettingsResult> {
  let observed: DietaryRecord | undefined;
  if (!storage) return clearDietarySettingsResult(null);
  if (!lock) return { ok: false, settings: { ...DEFAULT_DIETARY_SETTINGS }, error: "locking_unavailable" };
  try {
    return await lock(() => {
      if (typeof window === "undefined") return clearDietarySettingsResult(storage);
      return dietaryTransaction<ClearDietarySettingsResult>(() => loadDietarySettings(storage), current => {
        observed = current;
        const next: DietaryRecord = { revision: current.revision + 1, settings: { ...DEFAULT_DIETARY_SETTINGS } };
        const mirror = clearDietarySettingsResult(storage);
        // Even a failed mirror erase must not resurrect the authoritative profile.
        // Report failure until every persistent copy has actually been removed.
        return { next, result: { ...mirror, revision: next.revision } };
      });
    });
  }
  catch { return { ok: false, settings: observed?.settings ?? { ...DEFAULT_DIETARY_SETTINGS },
    ...(observed ? { revision: observed.revision } : {}), error: "remove_failed" }; }
}

/**
 * Calculates updated conditions when toggling a preset.
 * Adding a preset merges its default conditions into the selected conditions.
 * Removing a preset deselects it, but leaves customized conditions intact unless specified.
 */
export function applyPresetToggle(
  current: DietarySettings,
  presetId: DietaryPresetId,
): DietarySettings {
  const isActive = current.activePresets.includes(presetId);
  const nextPresets = isActive
    ? current.activePresets.filter((id) => id !== presetId)
    : [...current.activePresets, presetId];

  if (!isActive) {
    // When activating a preset, merge its default conditions into selectedConditions
    const presetDef = DIETARY_PRESETS.find((p) => p.id === presetId);
    const addedConditions = presetDef ? presetDef.defaultConditions : [];
    const merged = Array.from(new Set([...current.selectedConditions, ...addedConditions]));
    return {
      activePresets: normalizeActivePresets(nextPresets),
      selectedConditions: normalizeSelectedConditions(merged),
    };
  }

  return {
    activePresets: normalizeActivePresets(nextPresets),
    selectedConditions: current.selectedConditions,
  };
}
