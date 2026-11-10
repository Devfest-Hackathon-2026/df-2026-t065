"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

let simulatedStatus: boolean | null = null;

/**
 * Returns whether the browser currently has network connectivity.
 * Safe to call during SSR (returns true by default unless simulated).
 */
export function isBrowserOnline(): boolean {
  if (simulatedStatus !== null) {
    return simulatedStatus;
  }
  if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
    return navigator.onLine;
  }
  return true;
}

/**
 * For testing / development simulation of online/offline transitions.
 * Set to null to revert to real navigator.onLine.
 */
export function setSimulatedOnlineStatus(online: boolean | null): void {
  simulatedStatus = online;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(online === false ? "offline" : "online"));
  }
}

function subscribeOnline(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

const emptySubscribe = () => () => {};

/**
 * Hook to detect client hydration without causing cascading renders.
 * SSR returns false; client returns true.
 */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

/**
 * Client-side snapshot for useSyncExternalStore.
 */
function getOnlineSnapshot(): boolean {
  return isBrowserOnline();
}

/**
 * Deterministic SSR snapshot. Always returns true to ensure SSR output
 * is identical regardless of runtime environment (N1 Hydration mismatch prevention).
 */
export const DETERMINISTIC_SERVER_SNAPSHOT = true;

function getServerOnlineSnapshot(): boolean {
  if (simulatedStatus !== null) {
    return simulatedStatus;
  }
  return DETERMINISTIC_SERVER_SNAPSHOT;
}

export type OnlineStatusState = {
  readonly isOffline: boolean;
  readonly showReconnectedBanner: boolean;
  readonly dismissReconnectedBanner: () => void;
};

/**
 * React hook to observe online/offline status with automatic reconnection notice.
 * Prevents hydration mismatch by ensuring the initial client render matches the
 * deterministic server snapshot, then synchronizing with real browser state after mount.
 */
export function useOnlineStatus(): OnlineStatusState {
  const isHydrated = useIsHydrated();

  const rawIsOnline = useSyncExternalStore(
    subscribeOnline,
    getOnlineSnapshot,
    getServerOnlineSnapshot,
  );

  // During SSR and initial client hydration (when not simulated in tests),
  // use deterministic online state (isOffline = false) to guarantee 100% hydration matching.
  // Once hydrated (or in test simulations), reflect the active status.
  const isOnline = simulatedStatus !== null || isHydrated ? rawIsOnline : DETERMINISTIC_SERVER_SNAPSHOT;
  const isOffline = !isOnline;

  const [showReconnectedBanner, setShowReconnectedBanner] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }

    let wasOffline = !isBrowserOnline();

    const handleOffline = () => {
      wasOffline = true;
      setShowReconnectedBanner(false);
    };

    const handleOnline = () => {
      if (wasOffline) {
        setShowReconnectedBanner(true);
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const dismissReconnectedBanner = useCallback(() => {
    setShowReconnectedBanner(false);
  }, []);

  return {
    isOffline,
    showReconnectedBanner,
    dismissReconnectedBanner,
  };
}
