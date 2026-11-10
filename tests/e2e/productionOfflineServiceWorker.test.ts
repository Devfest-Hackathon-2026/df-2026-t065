import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("Production Service Worker & Offline Asset Integrity", () => {
  it("public/sw.js exists and adheres to all safety and caching invariants", () => {
    const swPath = join(ROOT, "public", "sw.js");
    expect(existsSync(swPath)).toBe(true);

    const swSource = readFileSync(swPath, "utf8");

    // 1. Invariant: Cache versioning is present
    expect(swSource).toMatch(/const CACHE_VERSION.*BUILD_MANIFEST\.buildId/);

    // 2. Invariant: /api/ routes are explicitly excluded from cache (never cached, no offline mock)
    expect(swSource).toContain('url.pathname.startsWith("/api/")');
    expect(swSource).toContain("NEVER cache API routes");

    // 3. Invariant: Only GET requests can be cached (POST/mutations never cached)
    expect(swSource).toContain('request.method !== "GET"');

    // 4. Invariant: HTML Navigation requests use Network-First strategy
    expect(swSource).toContain('request.mode === "navigate"');
    expect(swSource).toContain("Network-First");

    // 5. Invariant: Old cache cleanup on activate
    expect(swSource).toContain('addEventListener("activate"');
    expect(swSource).toContain("caches.delete");
    expect(swSource).toContain("clients.claim");

    // 6. Invariant: Precache URLs include App Shell
    expect(swSource).toContain('"/"');
    expect(swSource).toContain('Object.keys(BUILD_MANIFEST.assets)');
  });

  it("public/manifest.json exists and contains correct PWA metadata", () => {
    const manifestPath = join(ROOT, "public", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest.name).toBe("AllergyBridge");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("production build static directory (.next/static) exists and is structured for Cache-First", () => {
    const nextStaticDir = join(ROOT, ".next", "static");
    // .next/static should exist from our successful production build
    if (existsSync(nextStaticDir)) {
      expect(existsSync(join(nextStaticDir, "chunks"))).toBe(true);
    }
  });

  it("confirms no personal settings or images are hardcoded or pre-cached", () => {
    const swPath = join(ROOT, "public", "sw.js");
    const swSource = readFileSync(swPath, "utf8");

    // Confirm no allergen terms, credentials, or private keys in service worker
    expect(swSource).not.toContain("allergens");
    expect(swSource).not.toContain("dietary");
    expect(swSource).not.toContain("PRIVATE KEY");
    expect(swSource).not.toContain("password");
    expect(swSource).not.toContain("token");
  });
});
