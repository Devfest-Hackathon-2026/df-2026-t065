"use client";

/**
 * Service Worker registration and cache lifecycle management for AllergyBridge.
 * Follows fail-closed, graceful degradation for Safari private browsing and non-supporting environments.
 * N3 Invariant: All CacheStorage operations are strictly scoped to the AllergyBridge namespace.
 */

export const ALLERGY_BRIDGE_CACHE_PREFIX = "allergy-bridge-";

export type ServiceWorkerRegistrationResult = {
  readonly supported: boolean;
  readonly registered: boolean;
  readonly error?: string;
};

/**
 * Registers the AllergyBridge service worker if supported by the browser environment.
 * Safe to call in unsupported browsers (e.g. Safari private browsing, older browsers, SSR).
 */
export async function registerServiceWorker(
  scriptUrl: string = "/offline-worker",
): Promise<ServiceWorkerRegistrationResult> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return { supported: false, registered: false };
  }

  try {
    const registration = await navigator.serviceWorker.register(scriptUrl, {
      scope: "/",
    });

    // Check for updates on mount
    if (registration.active) {
      registration.update().catch(() => {
        // Silently catch background update check errors (e.g. offline)
      });
    }

    return { supported: true, registered: true };
  } catch (error) {
    // Safari private mode or disabled SW: graceful degradation, card stays functional without SW
    const message = error instanceof Error ? error.message : String(error);
    return { supported: true, registered: false, error: message };
  }
}

/**
 * Checks whether the application shell AND essential static assets (JS/CSS)
 * are cached and ready for offline use (M1).
 * Never returns true for HTML-only cache without static script assets.
 */
export async function isOfflineReady(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) ||
        typeof MessageChannel === "undefined") return false;
    const expectedBuild = process.env.NEXT_PUBLIC_OFFLINE_BUILD_ID;
    const controller = navigator.serviceWorker.controller;
    if (!expectedBuild || !controller) return false;
    return await new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        channel.port1.close();
        channel.port2.close();
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), 5000);
      channel.port1.onmessage = ({ data }) => finish(
        navigator.serviceWorker.controller === controller &&
        data?.type === "PRECACHE_STATUS" && data.complete === true && data.version === expectedBuild,
      );
      try {
        controller.postMessage({ type: "GET_PRECACHE_STATUS" }, [channel.port2]);
      } catch {
        finish(false);
      }
    });
  } catch {
    return false;
  }
}

/**
 * Unregisters all active service workers for this origin.
 * Useful for tests, debugging, or full application reset.
 */
export async function unregisterServiceWorkers(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const results = await Promise.all(registrations.map((r) => r.unregister()));
    return results.every(Boolean);
  } catch {
    return false;
  }
}

/**
 * Deletes only CacheStorage caches managed by AllergyBridge.
 * Strictly preserves unrelated third-party or same-origin caches (N3).
 */
export async function clearAppCaches(): Promise<boolean> {
  if (typeof window === "undefined" || !("caches" in window)) {
    return false;
  }

  try {
    const keys = await caches.keys();
    const results = await Promise.all(
      keys
        .filter((k) => k.startsWith(ALLERGY_BRIDGE_CACHE_PREFIX))
        .map((k) => caches.delete(k).catch(() => false))
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}
