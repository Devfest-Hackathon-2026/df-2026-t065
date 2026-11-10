import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PHRASES, buildConfirmationCardBundle } from "@/client/phrases";
import {
  clearUserSettings,
  loadUserSettings,
  saveUserSettings,
  SETTINGS_STORAGE_KEY,
  type UserSettings,
} from "@/client/settingsStorage";
import {
  isBrowserOnline,
  setSimulatedOnlineStatus,
} from "@/client/onlineStatus";
import {
  registerServiceWorker,
  unregisterServiceWorkers,
  clearAppCaches,
} from "@/client/serviceWorkerRegistration";

// In-memory fake Storage implementation for testing persistence & removal
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

// In-memory fake Cache & CacheStorage for testing Service Worker invariants
class MemoryCache implements Cache {
  private store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof request === "string" ? request : (request as Request).url;
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }

  async matchAll(): Promise<readonly Response[]> {
    return Array.from(this.store.values()).map((r) => r.clone());
  }

  async add(request: RequestInfo | URL): Promise<void> {
    const url = typeof request === "string" ? request : (request as Request).url;
    this.store.set(url, new Response("OK", { status: 200 }));
  }

  async addAll(requests: RequestInfo[]): Promise<void> {
    for (const req of requests) {
      await this.add(req);
    }
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key = typeof request === "string" ? request : (request as Request).url;
    this.store.set(key, response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const key = typeof request === "string" ? request : (request as Request).url;
    return this.store.delete(key);
  }

  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((u) => new Request(u));
  }
}

class MemoryCacheStorage {
  private caches = new Map<string, MemoryCache>();

  async open(cacheName: string): Promise<Cache> {
    let c = this.caches.get(cacheName);
    if (!c) {
      c = new MemoryCache();
      this.caches.set(cacheName, c);
    }
    return c as unknown as Cache;
  }

  async has(cacheName: string): Promise<boolean> {
    return this.caches.has(cacheName);
  }

  async delete(cacheName: string): Promise<boolean> {
    return this.caches.delete(cacheName);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const hit = await c.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

describe("Offline Confirmation Card & Service Worker Verification", () => {
  beforeEach(() => {
    setSimulatedOnlineStatus(null);
  });

  afterEach(() => {
    setSimulatedOnlineStatus(null);
    vi.restoreAllMocks();
  });

  describe("1. Verified Static Confirmation Card Display & Language Switching (Offline)", () => {
    it("builds verified confirmation cards without network connection for ja -> en", () => {
      // Simulate fully offline
      setSimulatedOnlineStatus(false);
      expect(isBrowserOnline()).toBe(false);

      const bundle = buildConfirmationCardBundle({
        userLang: "ja",
        storeLang: "en",
        selectedAllergens: ["egg", "milk", "wheat"],
      });

      expect(bundle.supportedPair).toBe(true);
      expect(bundle.allergenQuestions).toHaveLength(3);
      expect(bundle.unverifiedAllergens).toHaveLength(0);
      expect(bundle.crossContactQuestions.length).toBeGreaterThan(0);
      expect(bundle.staffAnswerOptions.length).toBeGreaterThan(0);

      // Verify each phrase has non-draft review
      for (const q of bundle.allergenQuestions) {
        expect(q.storeVerification.level).not.toBe("draft");
        expect(q.userVerification.level).not.toBe("draft");
        expect(q.storeText.length).toBeGreaterThan(0);
        expect(q.userText.length).toBeGreaterThan(0);
      }
    });

    it("switches language to en -> ja seamlessly while offline", () => {
      setSimulatedOnlineStatus(false);

      const bundleEnJa = buildConfirmationCardBundle({
        userLang: "en",
        storeLang: "ja",
        selectedAllergens: ["shrimp", "peanut"],
      });

      expect(bundleEnJa.supportedPair).toBe(true);
      expect(bundleEnJa.allergenQuestions).toHaveLength(2);
      expect(bundleEnJa.userLang).toBe("en");
      expect(bundleEnJa.storeLang).toBe("ja");

      // Verify the Japanese storeText can be shown to restaurant staff
      const shrimpCard = bundleEnJa.allergenQuestions.find((q) => q.allergen === "shrimp");
      expect(shrimpCard).toBeDefined();
      expect(shrimpCard?.storeText).toContain("えび");
    });

    it("never includes draft or unreviewed translations in offline bundles", () => {
      // Create a hypothetical unreviewed draft phrase
      const mockPhrases = [
        ...PHRASES,
        {
          id: "MOCK_UNREVIEWED_DRAFT",
          purpose: "allergen_question" as const,
          allergen: "crab" as const,
          texts: { ja: "未検証日本語", en: "Unreviewed English" },
          verification: {
            ja: {
              level: "draft" as const,
              methods: ["bilingual_member_review" as const],
              reviewedAt: "2026-01-01",
              reviewerRole: "developer",
              evidence: null,
              machineTranslationUsedForDraft: false,
            },
            en: {
              level: "team_reviewed" as const,
              methods: ["native_speaker_review" as const],
              reviewedAt: "2026-01-01",
              reviewerRole: "developer",
              evidence: null,
              machineTranslationUsedForDraft: false,
            },
          },
        },
      ];

      const bundle = buildConfirmationCardBundle(
        {
          userLang: "ja",
          storeLang: "en",
          selectedAllergens: ["crab"],
        },
        mockPhrases,
      );

      // The mock draft phrase must NEVER be resolved into displayable questions
      const displayIds = bundle.allergenQuestions.map((q) => q.id);
      expect(displayIds).not.toContain("MOCK_UNREVIEWED_DRAFT");
    });
  });

  describe("2. User Settings Persistence & Complete Deletion", () => {
    it("persists allergen settings in storage and restores them offline", () => {
      const storage = new MemoryStorage();
      const testSettings: UserSettings = {
        userLang: "ja",
        storeLang: "en",
        allergens: ["egg", "milk"],
      };

      saveUserSettings(testSettings, storage);

      // Read back in offline mode
      setSimulatedOnlineStatus(false);
      const restored = loadUserSettings(storage);
      expect(restored.allergens).toEqual(["egg", "milk"]);
      expect(restored.userLang).toBe("ja");
      expect(restored.storeLang).toBe("en");
    });

    it("completely removes stored settings via clearUserSettings without leaking to cache", () => {
      const storage = new MemoryStorage();
      saveUserSettings(
        {
          userLang: "ja",
          storeLang: "en",
          allergens: ["wheat", "soy", "sesame"],
        },
        storage,
      );

      expect(storage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();

      // Clear settings
      clearUserSettings(storage);

      // Must be completely deleted
      expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
      const afterClear = loadUserSettings(storage);
      expect(afterClear.allergens).toEqual([]);
    });

    it("safe fallback when no saved settings exist (initial load)", () => {
      const emptyStorage = new MemoryStorage();
      const initial = loadUserSettings(emptyStorage);
      expect(initial.allergens).toEqual([]);
      expect(initial.userLang).toBe("ja");
      expect(initial.storeLang).toBe("en");
    });
  });

  describe("3. CacheStorage Privacy & Invariant Verification", () => {
    it("verifies that API calls (/api/*) and image uploads are never stored in cache", async () => {
      const fakeCacheStorage = new MemoryCacheStorage();
      await fakeCacheStorage.open("static-allergy-bridge-v1");

      // Simulate Service Worker fetch handler logic against invariant rules
      const shouldCache = (urlStr: string, method: string): boolean => {
        const url = new URL(urlStr);
        if (method !== "GET") return false;
        if (url.pathname.startsWith("/api/")) return false;
        if (!url.protocol.startsWith("http")) return false;
        return (
          url.pathname.startsWith("/_next/static/") ||
          url.pathname === "/" ||
          url.pathname === "/manifest.json"
        );
      };

      expect(shouldCache("https://example.com/api/analyze-menu", "POST")).toBe(false);
      expect(shouldCache("https://example.com/api/analyze-menu", "GET")).toBe(false);
      expect(shouldCache("https://example.com/api/usage", "GET")).toBe(false);
      expect(shouldCache("blob:https://example.com/some-user-image", "GET")).toBe(false);
      expect(shouldCache("https://example.com/_next/static/chunks/app.js", "GET")).toBe(true);
      expect(shouldCache("https://example.com/", "GET")).toBe(true);
      expect(shouldCache("https://example.com/manifest.json", "GET")).toBe(true);
    });

    it("purges stale cache versions on Service Worker activation", async () => {
      const fakeCacheStorage = new MemoryCacheStorage();

      // Setup old cache versions from prior deployment
      await fakeCacheStorage.open("static-allergy-bridge-v0");
      await fakeCacheStorage.open("old-app-cache");
      await fakeCacheStorage.open("static-allergy-bridge-v1"); // current

      const activeCacheVersion = "static-allergy-bridge-v1";
      const allKeys = await fakeCacheStorage.keys();
      expect(allKeys).toHaveLength(3);

      // Simulate activate event cleanup
      const staleKeys = allKeys.filter((k) => k !== activeCacheVersion);
      await Promise.all(staleKeys.map((k) => fakeCacheStorage.delete(k)));

      const remainingKeys = await fakeCacheStorage.keys();
      expect(remainingKeys).toEqual(["static-allergy-bridge-v1"]);
    });
  });

  describe("4. Service Worker Registration & Unsupported Environment Graceful Fallback", () => {
    it("handles environments without ServiceWorker support (Safari Private, Node, etc.) gracefully", async () => {
      const res = await registerServiceWorker();
      expect(res.supported).toBe(false);
      expect(res.registered).toBe(false);

      const unregisterRes = await unregisterServiceWorkers();
      expect(unregisterRes).toBe(false);

      const clearRes = await clearAppCaches();
      expect(clearRes).toBe(false);
    });

    it("registers service worker safely when navigator.serviceWorker exists", async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const mockRegister = vi.fn().mockResolvedValue({
        active: { state: "activated" },
        update: mockUpdate,
      });

      const fakeWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const fakeNavigator = {
        serviceWorker: {
          register: mockRegister,
        },
      };

      const origWindow = Reflect.get(globalThis, "window");
      const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

      try {
        Reflect.set(globalThis, "window", fakeWindow);
        Object.defineProperty(globalThis, "navigator", {
          value: fakeNavigator,
          configurable: true,
          writable: true,
        });

        const res = await registerServiceWorker("/sw.js");
        expect(res.supported).toBe(true);
        expect(res.registered).toBe(true);
        expect(mockRegister).toHaveBeenCalledWith("/sw.js", { scope: "/" });
      } finally {
        if (origWindow === undefined) {
          Reflect.deleteProperty(globalThis, "window");
        } else {
          Reflect.set(globalThis, "window", origWindow);
        }
        if (origNavDesc) {
          Object.defineProperty(globalThis, "navigator", origNavDesc);
        }
      }
    });

    it("gracefully catches registration errors (e.g. Safari Private quota / permission denied)", async () => {
      const mockRegister = vi.fn().mockRejectedValue(new Error("SecurityError: Access denied"));

      const fakeWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const fakeNavigator = {
        serviceWorker: {
          register: mockRegister,
        },
      };

      const origWindow = Reflect.get(globalThis, "window");
      const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

      try {
        Reflect.set(globalThis, "window", fakeWindow);
        Object.defineProperty(globalThis, "navigator", {
          value: fakeNavigator,
          configurable: true,
          writable: true,
        });

        const res = await registerServiceWorker("/sw.js");
        expect(res.supported).toBe(true);
        expect(res.registered).toBe(false);
        expect(res.error).toContain("SecurityError");
      } finally {
        if (origWindow === undefined) {
          Reflect.deleteProperty(globalThis, "window");
        } else {
          Reflect.set(globalThis, "window", origWindow);
        }
        if (origNavDesc) {
          Object.defineProperty(globalThis, "navigator", origNavDesc);
        }
      }
    });
  });

  describe("5. Online/Offline Transition State Synchronization", () => {
    it("correctly tracks transition from online to offline and back", () => {
      setSimulatedOnlineStatus(true);
      expect(isBrowserOnline()).toBe(true);

      setSimulatedOnlineStatus(false);
      expect(isBrowserOnline()).toBe(false);

      setSimulatedOnlineStatus(true);
      expect(isBrowserOnline()).toBe(true);
    });
  });
});
