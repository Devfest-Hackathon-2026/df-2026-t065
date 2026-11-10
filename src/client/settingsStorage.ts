import { z } from "zod";
import { ALLERGEN_CODES, AllergenCodeSchema, type AllergenCode } from "@/contracts/allergens";
import {
  SUPPORTED_LANGUAGE_PAIRS,
  isSupportedLanguagePair,
  type LanguagePair,
} from "@/contracts/analyze";

export const SETTINGS_STORAGE_KEY = "allergy_bridge_settings_v1";

export type UserSettings = {
  userLang: string;
  storeLang: string;
  allergens: AllergenCode[];
};

export const DEFAULT_USER_SETTINGS: Readonly<UserSettings> = {
  userLang: SUPPORTED_LANGUAGE_PAIRS[0]!.userLang,
  storeLang: SUPPORTED_LANGUAGE_PAIRS[0]!.storeLang,
  allergens: [],
};

const StoredSettingsSchema = z
  .object({
    userLang: z.string(),
    storeLang: z.string(),
    allergens: z.array(AllergenCodeSchema).max(ALLERGEN_CODES.length),
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

/**
 * Deduplicates and orders selected allergens according to the canonical ALLERGEN_CODES order.
 */
export function normalizeSelectedAllergens(allergens: readonly AllergenCode[]): AllergenCode[] {
  const selectedSet = new Set(allergens);
  return ALLERGEN_CODES.filter((code) => selectedSet.has(code));
}

/**
 * Validates and normalizes arbitrary input into safe UserSettings.
 * Unsupported language pairs or invalid allergen codes are rejected and fall back safely.
 */
export function sanitizeUserSettings(
  raw: unknown,
  pairs: readonly LanguagePair[] = SUPPORTED_LANGUAGE_PAIRS,
): UserSettings {
  const parsed = StoredSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      userLang: DEFAULT_USER_SETTINGS.userLang,
      storeLang: DEFAULT_USER_SETTINGS.storeLang,
      allergens: [],
    };
  }
  const { userLang, storeLang, allergens } = parsed.data;
  if (!isSupportedLanguagePair(userLang, storeLang, pairs)) {
    return {
      userLang: DEFAULT_USER_SETTINGS.userLang,
      storeLang: DEFAULT_USER_SETTINGS.storeLang,
      allergens: normalizeSelectedAllergens(allergens),
    };
  }
  return {
    userLang,
    storeLang,
    allergens: normalizeSelectedAllergens(allergens),
  };
}

export function loadUserSettings(storage: StorageLike | null = getDefaultStorage()): UserSettings {
  if (!storage) {
    return { ...DEFAULT_USER_SETTINGS, allergens: [] };
  }
  try {
    const rawJson = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!rawJson) {
      return { ...DEFAULT_USER_SETTINGS, allergens: [] };
    }
    const parsedJson: unknown = JSON.parse(rawJson);
    return sanitizeUserSettings(parsedJson);
  } catch {
    return { ...DEFAULT_USER_SETTINGS, allergens: [] };
  }
}

export function saveUserSettings(
  settings: UserSettings,
  storage: StorageLike | null = getDefaultStorage(),
): UserSettings {
  const sanitized = sanitizeUserSettings(settings);
  if (storage) {
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitized));
    } catch {
      // Ignore quota / privacy mode storage errors; in-memory state still works.
    }
  }
  return sanitized;
}

export function clearUserSettings(storage: StorageLike | null = getDefaultStorage()): UserSettings {
  if (storage) {
    try {
      storage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      // Ignore storage access errors
    }
  }
  return { ...DEFAULT_USER_SETTINGS, allergens: [] };
}
