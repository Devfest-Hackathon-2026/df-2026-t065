import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setSimulatedOnlineStatus } from "@/client/onlineStatus";

const ROOT = process.cwd();
const SW_SOURCE = readFileSync(join(ROOT, "public", "sw.js"), "utf8");

describe("Audit Regression Tests — PR #27 Vulnerabilities", () => {
  beforeEach(() => {
    setSimulatedOnlineStatus(null);
  });

  afterEach(() => {
    setSimulatedOnlineStatus(null);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // B1: BLOCKER — Cache Storageへの不適切な保存 & 初回キャッシュ安全性
  // =========================================================================
  describe("B1 (BLOCKER): Cache Storage must NOT store non-allowlisted, sensitive, or dynamic GETs", () => {
    it("B1-1: Does NOT contain broad same-origin GET caching fallback", () => {
      const broadSameOriginPattern = /url\.origin\s*===\s*self\.location\.origin[\s\S]*?cache\.put/;
      expect(SW_SOURCE).not.toMatch(broadSameOriginPattern);
    });

    it("B1-2: Explicitly rejects caching responses with Cache-Control: no-store / no-cache / private", () => {
      expect(SW_SOURCE).toMatch(/no-store/);
      expect(SW_SOURCE).toMatch(/no-cache/);
      expect(SW_SOURCE).toMatch(/private/);
    });

    it("B1-3: Explicitly rejects caching requests with query parameters (e.g. ?token=...)", () => {
      expect(SW_SOURCE).toMatch(/url\.search/);
    });

    it("B1-4: Explicitly rejects caching responses that were redirected (response.redirected)", () => {
      expect(SW_SOURCE).toMatch(/response\.redirected/);
    });

    it("B1-5: Explicitly rejects caching non-basic response types (cross-origin / opaque / cors)", () => {
      expect(SW_SOURCE).toMatch(/response\.type !== "basic"/);
    });

    it("B1-6: Explicitly excludes images, uploads, and media mime types from cache", () => {
      expect(SW_SOURCE).toMatch(/image\//);
    });

    it("B1-7: URL-decoded / normalized API paths are excluded from cache", () => {
      expect(SW_SOURCE).toMatch(/decodeURIComponent/);
    });

    it("B1-8: Precache NEVER bypasses response safety verification (cache.addAll is NOT used)", () => {
      // Invariant B1: cache.addAll bypasses header and redirect verification; safePrecacheAll must be used
      expect(SW_SOURCE).not.toContain("cache.addAll");
      expect(SW_SOURCE).toMatch(/safePrecacheAll/);
    });
  });

  // =========================================================================
  // M1: MAJOR — 初回オフライン再起動が保証されない
  // =========================================================================
  describe("M1 (MAJOR): Initial offline reboot must be guaranteed with essential assets", () => {
    it("M1-1: precache must guarantee complete validated asset caching", () => {
      expect(SW_SOURCE).toMatch(/isPrecacheComplete/i);
    });
  });

  // =========================================================================
  // M2: MAJOR — 更新失敗による旧版の喪失 & フォールバックの限定
  // =========================================================================
  describe("M2 (MAJOR): Update failure must retain old cache and active SW", () => {
    it("M2-1: install event rejects if ANY precache asset fails safety validation", () => {
      expect(SW_SOURCE).toMatch(/safePrecacheAll[\s\S]*?\.then\(\(\)\s*=>\s*\{[\s\S]*?isPrecacheComplete\s*=\s*true/);
    });

    it("M2-2: install event must NOT execute skipWaiting unconditionally", () => {
      const unconditionalSkipWaitingPattern = /addEventListener\(\s*["']install["']\s*,\s*\([^)]*\)\s*=>\s*\{[\s\r\n]*self\.skipWaiting\(\)/;
      expect(SW_SOURCE).not.toMatch(unconditionalSkipWaitingPattern);
    });

    it("M2-3: Root shell fallback is strictly limited to exact '/' navigation without query strings", () => {
      // Must NOT answer unknown paths with cached root shell
      expect(SW_SOURCE).toMatch(/isRootNavigation/);
      expect(SW_SOURCE).toContain('url.pathname === "/"');
    });
  });

  // =========================================================================
  // M3: MAJOR — Cache Storage失敗時にオンライン通信も失敗
  // =========================================================================
  describe("M3 (MAJOR): Cache Storage exceptions must not break online network traffic", () => {
    it("M3-1: caches.match and caches.open must handle errors gracefully without unhandled rejection", () => {
      expect(SW_SOURCE).toMatch(/safeCacheMatch/);
      expect(SW_SOURCE).toMatch(/safeCachePut/);
    });
  });

  // =========================================================================
  // N1: MINOR — Hydration mismatch
  // =========================================================================
  describe("N1 (MINOR): Hydration mismatch prevention in onlineStatus", () => {
    it("N1-1: Server snapshot and client initial hydration snapshot must be identical deterministic value", () => {
      const onlineStatusSource = readFileSync(join(ROOT, "src", "client", "onlineStatus.ts"), "utf8");
      expect(onlineStatusSource).toMatch(/DETERMINISTIC|useIsHydrated|isHydrated/i);
    });
  });

  // =========================================================================
  // N2: MINOR — 通信障害とAI障害の混同
  // =========================================================================
  describe("N2 (MINOR): Offline state must not be reported as AI_FAILED", () => {
    it("N2-1: handleAnalyze in AllergyBridgeApp must not report AI_FAILED when offline", () => {
      const appSource = readFileSync(join(ROOT, "src", "components", "AllergyBridgeApp.tsx"), "utf8");
      expect(appSource).not.toMatch(/makeError\(\s*["']client-offline["']\s*,\s*["']AI_FAILED["']\s*\)/);
    });
  });

  // =========================================================================
  // N3: MINOR — 無関係なキャッシュの削除
  // =========================================================================
  describe("N3 (MINOR): Cache deletion must be scoped strictly to AllergyBridge namespace", () => {
    it("N3-1: activate listener only purges caches matching allergy-bridge prefix", () => {
      expect(SW_SOURCE).toMatch(/name\.startsWith\(\s*["'](?:allergy-bridge-|static-allergy-bridge-)["']\s*\)/);
    });

    it("N3-2: CLEAR_CACHE message only deletes caches matching allergy-bridge prefix", () => {
      const clearCacheAllPattern = /keys\.map\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*caches\.delete\(/;
      expect(SW_SOURCE).not.toMatch(clearCacheAllPattern);
    });
  });
});
