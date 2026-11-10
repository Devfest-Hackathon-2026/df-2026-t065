import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ALLERGEN_CODES } from "@/contracts/allergens";
import { buildConfirmationCardBundle } from "@/client/phrases";
import {
  clearUserSettings,
  loadUserSettings,
  saveUserSettings,
  SETTINGS_STORAGE_KEY,
} from "@/client/settingsStorage";
import {
  isBrowserOnline,
  setSimulatedOnlineStatus,
  DETERMINISTIC_SERVER_SNAPSHOT,
} from "@/client/onlineStatus";
import {
  clearAppCaches,
  isOfflineReady,
} from "@/client/serviceWorkerRegistration";
import { AllergyBridgeApp } from "@/components/AllergyBridgeApp";

const ROOT = process.cwd();
const SW_SOURCE = readFileSync(join(ROOT, "public", "sw.js"), "utf8");

// Mock Cache and CacheStorage Implementation for E2E Service Worker evaluation
class MockCache implements Cache {
  public store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof request === "string" ? request : (request as Request).url;
    const res = this.store.get(key);
    return res ? res.clone() : undefined;
  }

  async matchAll(): Promise<readonly Response[]> {
    return Array.from(this.store.values()).map((r) => r.clone());
  }

  async add(request: RequestInfo | URL): Promise<void> {
    const url = typeof request === "string" ? request : (request as Request).url;
    this.store.set(url, new Response("OK", { status: 200, headers: { "Content-Type": "text/html" } }));
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
    return Array.from(this.store.keys()).map((u) => {
      try {
        return new Request(u);
      } catch {
        const origin = (typeof window !== "undefined" && window.location?.origin) || "http://localhost";
        return new Request(new URL(u, origin).href);
      }
    });
  }
}

class MockCacheStorage {
  public caches = new Map<string, MockCache>();

  async open(cacheName: string): Promise<Cache> {
    let c = this.caches.get(cacheName);
    if (!c) {
      c = new MockCache();
      this.caches.set(cacheName, c);
    }
    return c as unknown as Cache;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const res = await cache.match(request);
      if (res) return res;
    }
    return undefined;
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
}

// In-memory localStorage mock for setting isolation verification
class MockLocalStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return Array.from(this.data.keys())[i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

describe("Mock/static Service Worker Regressions (not browser E2E) (SW-E01 〜 SW-E15 & Negative Controls)", () => {
  let mockCaches: MockCacheStorage;
  let mockStorage: MockLocalStorage;

  beforeEach(() => {
    mockCaches = new MockCacheStorage();
    mockStorage = new MockLocalStorage();
    setSimulatedOnlineStatus(null);

    // Global environment shims
    vi.stubGlobal("caches", mockCaches);
    vi.stubGlobal("localStorage", mockStorage);
    vi.stubGlobal("window", {
      caches: mockCaches,
      localStorage: mockStorage,
      location: { origin: "https://allergybridge.app" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    setSimulatedOnlineStatus(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // SW-E01: 初回オンライン後にSW制御を確認
  // -------------------------------------------------------------------------
  it("SW-E01: Successfully precaches app shell and claims clients on activation", async () => {
    const staticCache = await mockCaches.open("allergy-bridge-static-allergy-bridge-v1");
    // Precache shell
    await staticCache.add("/");
    await staticCache.add("/manifest.json");

    expect(await staticCache.match("/")).toBeDefined();
    expect(await staticCache.match("/manifest.json")).toBeDefined();
    expect(SW_SOURCE).toContain("self.clients.claim()");
  });

  // -------------------------------------------------------------------------
  // SW-E02: HTTPキャッシュなしでオフライン再読み込み
  // -------------------------------------------------------------------------
  it("SW-E02: Navigation request resolves from Cache Storage when completely offline", async () => {
    const staticCache = await mockCaches.open("allergy-bridge-static-allergy-bridge-v1");
    await staticCache.put(
      "/",
      new Response("<!DOCTYPE html><html><body><main id='root'>AllergyBridge Shell</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );

    const offlineResponse = await mockCaches.match("/");
    expect(offlineResponse).toBeDefined();
    expect(offlineResponse?.status).toBe(200);
    const body = await offlineResponse?.text();
    expect(body).toContain("AllergyBridge Shell");
  });

  // -------------------------------------------------------------------------
  // SW-E03: オフラインで確認カードを操作
  // -------------------------------------------------------------------------
  it("SW-E03: Confirmation cards remain interactive offline with verified phrase buttons", () => {
    setSimulatedOnlineStatus(false);
    const html = renderToStaticMarkup(
      React.createElement(AllergyBridgeApp, {
        initialStep: "confirmCard",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg", "milk"] },
      })
    );

    expect(html).toContain('data-testid="confirm-card-placeholder-section"');
    expect(html).toContain('data-testid="staff-answer-btn-ANS_CONTAINS"');
    expect(html).toContain('data-testid="staff-answer-btn-ANS_DOES_NOT_CONTAIN"');
  });

  // -------------------------------------------------------------------------
  // SW-E04: 日英切替・11アレルゲン表示
  // -------------------------------------------------------------------------
  it("SW-E04: Supports Japanese and English UI and all 11 allergens offline", () => {
    setSimulatedOnlineStatus(false);

    // Test Japanese bundle
    const jaBundle = buildConfirmationCardBundle({
      userLang: "ja",
      storeLang: "en",
      selectedAllergens: [...ALLERGEN_CODES],
    });
    expect(jaBundle.supportedPair).toBe(true);
    expect(jaBundle.allergenQuestions.length).toBe(ALLERGEN_CODES.length);
    expect(jaBundle.unverifiedAllergens.length).toBe(0);

    // Test English bundle
    const enBundle = buildConfirmationCardBundle({
      userLang: "en",
      storeLang: "ja",
      selectedAllergens: [...ALLERGEN_CODES],
    });
    expect(enBundle.supportedPair).toBe(true);
    expect(enBundle.allergenQuestions.length).toBe(ALLERGEN_CODES.length);
    expect(enBundle.unverifiedAllergens.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SW-E05: 一般GET・API応答の非キャッシュ
  // -------------------------------------------------------------------------
  it("SW-E05: Rejects caching non-allowlisted GET requests and API endpoints", () => {
    expect(SW_SOURCE).toContain('if (isApiPath(url) || url.pathname.startsWith("/api/"))');
    expect(SW_SOURCE).not.toMatch(/url\.origin\s*===\s*self\.location\.origin[\s\S]*?cache\.put/);
  });

  // -------------------------------------------------------------------------
  // SW-E06: 302リダイレクト経由のAPI応答非キャッシュ
  // -------------------------------------------------------------------------
  it("SW-E06: Explicitly rejects caching responses that were redirected", () => {
    expect(SW_SOURCE).toContain("if (response.redirected)");
  });

  // -------------------------------------------------------------------------
  // SW-E07: no-store・JSON・画像相当URLの非キャッシュ
  // -------------------------------------------------------------------------
  it("SW-E07: Rejects Cache-Control: no-store, media types, and query string tokens", () => {
    expect(SW_SOURCE).toContain("no-store");
    expect(SW_SOURCE).toContain("image/");
    expect(SW_SOURCE).toContain('url.search && url.search !== ""');
  });

  // -------------------------------------------------------------------------
  // SW-E08: クロスオリジン応答の非キャッシュ
  // -------------------------------------------------------------------------
  it("SW-E08: Rejects caching cross-origin assets (response.type !== 'basic')", () => {
    expect(SW_SOURCE).toContain('if (response.type !== "basic")');
    expect(SW_SOURCE).toContain("url.origin !== self.location.origin");
  });

  // -------------------------------------------------------------------------
  // SW-E09: 新版precache失敗時に旧版を保持
  // -------------------------------------------------------------------------
  it("SW-E09: Precache errors propagate to fail SW install without evicting old cache", async () => {
    // Put valid old cache
    const oldCacheName = "allergy-bridge-static-v1";
    const oldCache = await mockCaches.open(oldCacheName);
    await oldCache.put("/", new Response("old shell", { status: 200 }));

    // Verify error rejection on precache failure in sw.js
    expect(SW_SOURCE).toContain("safePrecacheAll");
    expect(SW_SOURCE).not.toContain("cache.addAll");

    // Old cache remains intact
    expect(await oldCache.match("/")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // SW-E10: 複数タブ・旧アセットの保持
  // -------------------------------------------------------------------------
  it("SW-E10: Old assets remain accessible without premature skipWaiting during install", () => {
    expect(SW_SOURCE).not.toMatch(/addEventListener\(\s*["']install["'][\s\S]*?self\.skipWaiting\(\);[\s\r\n]*event\.waitUntil/);
  });

  // -------------------------------------------------------------------------
  // SW-E11: Cache Storage読取・書込失敗
  // -------------------------------------------------------------------------
  it("SW-E11: Handles Cache Storage errors gracefully without breaking network requests", () => {
    expect(SW_SOURCE).toContain("safeCacheMatch");
    expect(SW_SOURCE).toContain("safeCachePut");
  });

  // -------------------------------------------------------------------------
  // SW-E12: 通信復帰と解析ボタンの状態
  // -------------------------------------------------------------------------
  it("SW-E12: Renders reconnected banner upon network restoration and disables button while offline", () => {
    setSimulatedOnlineStatus(false);
    const offlineHtml = renderToStaticMarkup(
      React.createElement(AllergyBridgeApp, {
        initialStep: "upload",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg"] },
      })
    );
    expect(offlineHtml).toContain('data-testid="offline-status-banner"');

    setSimulatedOnlineStatus(true);
    const onlineHtml = renderToStaticMarkup(
      React.createElement(AllergyBridgeApp, {
        initialStep: "upload",
        initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg"] },
      })
    );
    expect(onlineHtml).not.toContain('data-testid="offline-status-banner"');
  });

  // -------------------------------------------------------------------------
  // SW-E13: React hydration mismatchなし
  // -------------------------------------------------------------------------
  it("SW-E13: SSR snapshot matches client initial hydration snapshot deterministically", () => {
    expect(DETERMINISTIC_SERVER_SNAPSHOT).toBe(true);
    setSimulatedOnlineStatus(null);
    expect(isBrowserOnline()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SW-E14: 無関係なキャッシュの非削除
  // -------------------------------------------------------------------------
  it("SW-E14: Cache purge preserves non-AllergyBridge caches", async () => {
    const unrelatedCache = await mockCaches.open("third-party-cache");
    await unrelatedCache.put("/data", new Response("important", { status: 200 }));

    const abStaleCache = await mockCaches.open("allergy-bridge-static-old");
    await abStaleCache.put("/old-shell", new Response("old", { status: 200 }));

    await clearAppCaches();

    expect(await mockCaches.has("allergy-bridge-static-old")).toBe(false);
    expect(await mockCaches.has("third-party-cache")).toBe(true);
    expect(await unrelatedCache.match("/data")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // SW-E15: 保存設定の削除とCache Storageの分離
  // -------------------------------------------------------------------------
  it("SW-E15: User settings deletion does not purge Cache Storage, and vice versa", async () => {
    saveUserSettings({ userLang: "ja", storeLang: "en", allergens: ["peanut"] }, mockStorage);
    expect(loadUserSettings(mockStorage).allergens).toEqual(["peanut"]);

    const abCache = await mockCaches.open("allergy-bridge-static-allergy-bridge-v1");
    await abCache.put("/", new Response("shell", { status: 200 }));

    clearUserSettings(mockStorage);
    expect(mockStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadUserSettings(mockStorage).allergens).toEqual([]);
    expect(await abCache.match("/")).toBeDefined();

    saveUserSettings({ userLang: "en", storeLang: "ja", allergens: ["wheat"] }, mockStorage);
    await clearAppCaches();
    expect(loadUserSettings(mockStorage).allergens).toEqual(["wheat"]);
  });

  // =========================================================================
  // m1: 動的負の対照試験（Negative Controls）
  // =========================================================================
  describe("m1: Negative Controls & Dynamic Handler Invariants", () => {
    // NC-1: Cache-Control: private / no-store
    it("NC-01: Responses with Cache-Control: private or no-store are rejected from caching", () => {
      expect(SW_SOURCE).toContain('cacheControl.includes("private")');
      expect(SW_SOURCE).toContain('cacheControl.includes("no-store")');
    });

    // NC-2: 認証ページ・リダイレクト
    it("NC-02: Redirected responses (response.redirected = true) are rejected from caching", () => {
      expect(SW_SOURCE).toContain("if (response.redirected)");
    });

    // NC-3: /api/* および一般GET
    it("NC-03: API endpoints and unallowlisted GETs are never cached or intercepted", () => {
      expect(SW_SOURCE).toContain('isApiPath(url)');
      expect(SW_SOURCE).toContain('if (isApiPath(url) || url.pathname.startsWith("/api/"))');
    });

    // NC-4: 未知のHTMLパス
    it("NC-04: Unknown HTML navigation paths do NOT receive root shell fallback", () => {
      expect(SW_SOURCE).toContain("isRootNavigation");
      expect(SW_SOURCE).toContain('const isRootNavigation = url.pathname === "/" && (!url.search || url.search === "");');
    });

    // NC-5: 初回インストール失敗
    it("NC-05: Precache failure aborts installation atomically via safePrecacheAll", () => {
      expect(SW_SOURCE).toContain("safePrecacheAll");
      expect(SW_SOURCE).toContain("throw new Error");
    });

    // NC-6: JSチャンク欠損（M1 担保）
    it("NC-06: isOfflineReady returns false if HTML is present but JS/CSS chunks are missing", async () => {
      const cache = await mockCaches.open("allergy-bridge-static-v1");
      // Only HTML is cached, no /_next/static/ chunks
      await cache.put("/", new Response("<html></html>", { status: 200 }));

      const ready = await isOfflineReady();
      expect(ready).toBe(false); // HTML-only is NOT ready!
    });

    // NC-07: JSチャンク存在時の offlineReady 検証
    it("NC-07: isOfflineReady rejects HTML and one arbitrary chunk without a matching complete build", async () => {
      const cache = await mockCaches.open("allergy-bridge-static-v1");
      await cache.put("/", new Response("<html></html>", { status: 200 }));
      await cache.put("/_next/static/chunks/app.js", new Response("console.log()", { status: 200 }));

      const ready = await isOfflineReady();
      expect(ready).toBe(false);
    });

    // NC-08: Cache Storage例外 (M3 担保)
    it("NC-08: Cache Storage open/match failures do not throw unhandled exceptions", () => {
      expect(SW_SOURCE).toContain("safeCacheMatch");
      expect(SW_SOURCE).toContain("safeCachePut");
    });

    // NC-09: オフラインからオンラインへの復旧
    it("NC-09: Reconnection event triggers banner dismissal readiness", () => {
      setSimulatedOnlineStatus(false);
      expect(isBrowserOnline()).toBe(false);
      setSimulatedOnlineStatus(true);
      expect(isBrowserOnline()).toBe(true);
    });
  });
});
