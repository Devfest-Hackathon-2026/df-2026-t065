// AllergyBridge — Service Worker for Offline Static Confirmation Cards
// Safety Invariants (AGENTS.md):
// 1. NEVER cache API responses (/api/*, Gemini, Firestore, usage endpoints), uploads, user settings, or images.
// 2. Cache ONLY static shell and precompiled scripts strictly required for offline card display.
// 3. Strict allowlist-only caching: any unrecognized path, query param, or redirect is rejected.
// 4. Precache integrity (B1): every precached asset MUST pass the full safety validation before storing.
//    Native bulk precaching without header inspection is prohibited; safePrecacheAll verifies each asset.
//    Any response with private, no-store, redirect, non-200, or non-basic type immediately aborts installation.
// 5. App Shell fallback scoping (M2): cached root shell is served ONLY for exact root navigation ("/").
//    Unknown paths, authentication routes, and query-bearing URLs are never answered with root shell fallback.
// 6. Cache Storage failures must NEVER break online network requests (M3).
// 7. Cache purge must be strictly scoped to AllergyBridge namespace (N3).

// The unbuilt public template fails closed. /offline-worker serves the generated
// source from this deployment's .next/static artifacts.
const CACHE_VERSION = typeof BUILD_MANIFEST === "undefined" ? null : BUILD_MANIFEST.buildId;
const CACHE_PREFIX = "allergy-bridge-";
const STATIC_CACHE_NAME = `${CACHE_PREFIX}build-${CACHE_VERSION}`;
const PRECACHE_URLS = CACHE_VERSION ? ["/", ...Object.keys(BUILD_MANIFEST.assets)] : [];
let isPrecacheComplete = false;

// Allowed Content-Type MIME categories for cached static assets
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/javascript",
  "text/javascript",
  "text/css",
  "application/json",
  "font/",
  "text/plain",
];

/**
 * Checks if a URL path points to an API endpoint (including encoded or relative paths).
 * Invariant: NEVER cache API routes (/api/*, Gemini, Firestore, usage endpoints).
 */
function isApiPath(url) {
  try {
    // Fast path: explicit check on pathname
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      return true;
    }
    const rawPath = url.pathname.toLowerCase();
    const decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.startsWith("/api/") || decodedPath === "/api") {
      return true;
    }
    // Check for encoded slashes or traversal attempts
    const normalized = decodedPath.replace(/\/+/g, "/");
    return normalized.startsWith("/api/") || normalized === "/api";
  } catch {
    // If URI decoding fails, treat as dangerous / API-like
    return true;
  }
}

/**
 * Strict Allowlist: returns true ONLY if the URL is an explicitly allowed static resource.
 */
function isAllowlistedStaticUrl(url) {
  // 1. Must be exact same origin
  if (url.origin !== self.location.origin) {
    return false;
  }

  // 2. Reject any query parameters or hash to prevent caching dynamic query strings
  if (url.search && url.search !== "") {
    return false;
  }

  // 3. Exclude all API routes
  if (isApiPath(url) || url.pathname.startsWith("/api/")) {
    return false;
  }

  // 4. Exact allowlist checks
  const pathname = url.pathname;
  if (pathname === "/") return true;
  if (CACHE_VERSION && Object.hasOwn(BUILD_MANIFEST.assets, pathname)) return true;

  return false;
}

/**
 * Validates whether a network Response is safe to store into Cache Storage.
 * Enforces B1 safety requirements for both runtime and precache storage:
 * - Must be status 200 (reject 401, 403, 302, 500, etc.)
 * - Must be basic type (reject cors, opaque, error)
 * - Must NOT be redirected (prevents caching login redirect landing pages)
 * - Must NOT contain private, no-store, or no-cache in Cache-Control
 * - Content-Type must strictly match allowed static MIME types (reject images, uploads, API JSON)
 */
function isResponseCacheable(request, response) {
  if (!response || response.status !== 200) {
    return false;
  }

  // Only basic (same-origin, non-opaque, non-cors) responses
  if (response.type !== "basic") {
    return false;
  }

  // Reject redirected responses (e.g. 302 redirecting to API or Cloud Run auth landing)
  if (response.redirected) {
    return false;
  }

  // Verify final response URL against allowlist if available
  if (response.url) {
    try {
      const finalUrl = new URL(response.url);
      if (!isAllowlistedStaticUrl(finalUrl)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  // Inspect Cache-Control header: strictly forbid private, no-store, and no-cache
  const cacheControl = (response.headers.get("Cache-Control") || "").toLowerCase();
  if (
    cacheControl.includes("no-store") ||
    cacheControl.includes("no-cache") ||
    cacheControl.includes("private")
  ) {
    return false;
  }

  // Inspect Content-Type: reject images, media, or disallowed MIME types
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.startsWith("image/") || contentType.startsWith("video/") || contentType.startsWith("audio/")) {
    return false;
  }

  const isAllowedType = ALLOWED_CONTENT_TYPES.some((allowed) => contentType.includes(allowed));
  if (!isAllowedType) {
    return false;
  }

  return true;
}

// Only responses byte-identical to the build artifacts may enter this cache.
// This also rejects authentication landing pages returning HTTP 200 at root.
async function responseHash(response) {
  const bytes = await response.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectedHash(path) {
  return path === "/" ? BUILD_MANIFEST.rootHash : BUILD_MANIFEST.assets[path];
}

async function matchesBuild(path, response) {
  return !!response && response.status === 200 &&
    await responseHash(response.clone()) === expectedHash(path);
}

async function safeCacheMatch(request) {
  try {
    if (!CACHE_VERSION || !(await caches.has(STATIC_CACHE_NAME))) return undefined;
    const cache = await caches.open(STATIC_CACHE_NAME);
    const cached = await cache.match(request);
    const path = new URL(typeof request === "string" ? request : request.url, self.location.origin).pathname;
    return await matchesBuild(path, cached) ? cached : undefined;
  } catch {
    return undefined;
  }
}

async function safeCachePut(cacheName, request, response) {
  const path = new URL(typeof request === "string" ? request : request.url, self.location.origin).pathname;
  if (!isResponseCacheable(request, response) || !(await matchesBuild(path, response))) return false;
  try {
    const cache = await caches.open(cacheName);
    // Do not persist authentication or other incidental network headers.
    await cache.put(request, new Response(await response.arrayBuffer(), {
      headers: { "Content-Type": response.headers.get("Content-Type") || "text/plain" },
    }));
    return true;
  } catch {
    return false;
  }
}

async function completeBuildCached() {
  if (!CACHE_VERSION) return false;
  try {
    for (const path of PRECACHE_URLS) {
      if (!(await safeCacheMatch(path))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function safePrecacheAll(cacheName, urls) {
  if (!CACHE_VERSION) throw new Error("Unbuilt offline worker");
  if (await completeBuildCached()) return;
  // Every generation has its own namespace; failed installation cannot modify
  // the active generation. Only a completely validated build may activate.
  for (const path of urls) {
    const request = new Request(new URL(path, self.location.origin), { credentials: "omit", cache: "no-store", redirect: "error" });
    const response = await fetch(request);
    if (!(await safeCachePut(cacheName, path, response))) {
      throw new Error("Offline build incomplete or response rejected");
    }
  }
  if (!(await completeBuildCached())) throw new Error("Offline build incomplete");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    safePrecacheAll(STATIC_CACHE_NAME, PRECACHE_URLS).then(() => {
      isPrecacheComplete = true;
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      // No skipWaiting: existing tabs retain their controller and assets.
      // Conservatively retain old generations if ANY window might use them.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.length === 0) {
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith("allergy-bridge-") && name !== STATIC_CACHE_NAME)
          .map((name) => caches.delete(name).catch(() => false)));
      }
    } catch { /* Storage failure must not break online use. */ }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!url.protocol.startsWith("http")) return;
  if (isApiPath(url) || url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin) return;
  // Explicit Authorization is never persisted or answered from cache.
  if (request.headers.has("authorization")) return;

  // Network-First HTML, with a fallback restricted to this exact build.
  if (request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html")) {
    const isRootNavigation = url.pathname === "/" && (!url.search || url.search === "");
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        // A newer deployment's HTML is returned online, but NEVER replaces this
        // controller's root. Its matching assets are network-only until update.
        if (isRootNavigation) event.waitUntil(safeCachePut(STATIC_CACHE_NAME, "/", network.clone()).catch(() => false));
        return network;
      } catch {
        if (isRootNavigation) {
          const cached = await safeCacheMatch("/");
          if (cached) return cached;
        }
        return new Response("Offline - Page not available offline", { status: 503 });
      }
    })());
    return;
  }

  if (!isAllowlistedStaticUrl(url)) return;
  event.respondWith((async () => {
    const cached = await safeCacheMatch(request);
    if (cached) return cached; // Content-addressed, verified build assets are immutable.
    const network = await fetch(request);
    event.waitUntil(safeCachePut(STATIC_CACHE_NAME, request, network.clone()).catch(() => false));
    return network;
  })());
});

self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "GET_PRECACHE_STATUS" && event.ports && event.ports[0]) {
    event.waitUntil((async () => {
      // Recompute after eviction, worker restart, deletion, or failed writes.
      isPrecacheComplete = await completeBuildCached();
      event.ports[0].postMessage({ type: "PRECACHE_STATUS", complete: isPrecacheComplete, version: CACHE_VERSION });
    })());
  } else if (event.data.type === "CLEAR_CACHE") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys
      .filter((k) => k.startsWith("allergy-bridge-"))
      .map((k) => caches.delete(k).catch(() => false)))).catch(() => {}));
  }
  // No SKIP_WAITING message: a page cannot evict another tab's controller.
});
