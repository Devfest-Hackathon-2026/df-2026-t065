"use client";

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UiMessages } from "@/client/i18n";
import styles from "./AllergyBridgeApp.module.css";

type ImageSource = "original" | "processed";

export type ImageReconciliationViewProps = {
  originalPreviewUrl: string | null;
  processedPreviewUrl: string | null;
  messages: UiMessages["results"];
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const KEYBOARD_PAN_STEP = 24;

function subscribeDesktopMedia(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const mq = window.matchMedia("(min-width: 680px)");
  mq.addEventListener("change", callback);
  return () => {
    mq.removeEventListener("change", callback);
  };
}

function getDesktopSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia("(min-width: 680px)").matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function ImageReconciliationView({
  originalPreviewUrl,
  processedPreviewUrl,
  messages,
}: ImageReconciliationViewProps) {
  const [activeSource, setActiveSource] = useState<ImageSource>("original");
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const isDesktop = useSyncExternalStore(subscribeDesktopMedia, getDesktopSnapshot, getServerSnapshot);

  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const initialPinchDistRef = useRef<number | null>(null);
  const initialPinchZoomRef = useRef<number>(1);
  const viewportElsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const originalTabRef = useRef<HTMLButtonElement | null>(null);
  const processedTabRef = useRef<HTMLButtonElement | null>(null);

  const hasOriginal = Boolean(originalPreviewUrl);
  const effectiveSource: ImageSource = hasOriginal ? activeSource : "processed";
  const activeUrl = effectiveSource === "original" ? originalPreviewUrl : processedPreviewUrl;

  const resetView = () => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
    activePointersRef.current.clear();
    initialPinchDistRef.current = null;
  };

  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((current + delta).toFixed(2)))));
  }, []);

  // MINOR-1: Non-passive native wheel listener to cancel default page scroll and update zoom
  const handleNativeWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      changeZoom(delta);
    },
    [changeZoom],
  );

  const registerViewportRef = useCallback(
    (source: string) => (el: HTMLDivElement | null) => {
      const prevEl = viewportElsRef.current.get(source);
      if (prevEl && prevEl !== el) {
        prevEl.removeEventListener("wheel", handleNativeWheel);
        viewportElsRef.current.delete(source);
      }
      if (el) {
        viewportElsRef.current.set(source, el);
        el.addEventListener("wheel", handleNativeWheel, { passive: false });
      }
    },
    [handleNativeWheel],
  );

  useEffect(() => {
    const currentMap = viewportElsRef.current;
    return () => {
      currentMap.forEach((el) => {
        el.removeEventListener("wheel", handleNativeWheel);
      });
      currentMap.clear();
    };
  }, [handleNativeWheel]);

  const selectSource = (source: ImageSource) => {
    setActiveSource(source);
    resetView();
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!hasOriginal) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectSource("processed");
      processedTabRef.current?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectSource("original");
      originalTabRef.current?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      selectSource("original");
      originalTabRef.current?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      selectSource("processed");
      processedTabRef.current?.focus();
    }
  };

  const handleViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (zoom <= MIN_ZOOM) return;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowUp") {
      dy = KEYBOARD_PAN_STEP;
    } else if (event.key === "ArrowDown") {
      dy = -KEYBOARD_PAN_STEP;
    } else if (event.key === "ArrowLeft") {
      dx = KEYBOARD_PAN_STEP;
    } else if (event.key === "ArrowRight") {
      dx = -KEYBOARD_PAN_STEP;
    } else {
      return;
    }
    event.preventDefault();
    setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
  };

  // Pointer events supporting 1-finger pan and 2-finger pinch zoom (MINOR-2)
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!activeUrl) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointersRef.current.size === 1) {
      if (zoom > MIN_ZOOM) {
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }
    } else if (activePointersRef.current.size === 2) {
      dragRef.current = null;
      const pointers = Array.from(activePointersRef.current.values());
      const p1 = pointers[0];
      const p2 = pointers[1];
      if (p1 && p2) {
        initialPinchDistRef.current = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        initialPinchZoomRef.current = zoom;
      }
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(event.pointerId)) return;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointersRef.current.size === 2 && initialPinchDistRef.current && initialPinchDistRef.current > 0) {
      const pointers = Array.from(activePointersRef.current.values());
      const p1 = pointers[0];
      const p2 = pointers[1];
      if (p1 && p2) {
        const currentDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        const ratio = currentDist / initialPinchDistRef.current;
        const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number((initialPinchZoomRef.current * ratio).toFixed(2))));
        setZoom(targetZoom);
      }
    } else if (activePointersRef.current.size === 1 && dragRef.current && dragRef.current.pointerId === event.pointerId) {
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      dragRef.current = { pointerId: dragRef.current.pointerId, x: event.clientX, y: event.clientY };
      setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
    }
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
    }

    if (activePointersRef.current.size === 1) {
      initialPinchDistRef.current = null;
      const remaining = Array.from(activePointersRef.current.entries())[0];
      if (remaining && zoom > MIN_ZOOM) {
        dragRef.current = { pointerId: remaining[0], x: remaining[1].x, y: remaining[1].y };
      }
    } else {
      initialPinchDistRef.current = null;
      dragRef.current = null;
    }
  };

  return (
    <section className={styles.imageReconciliation} aria-labelledby="image-reconciliation-title" data-testid="image-reconciliation">
      <div className={styles.imageReconciliationHeader}>
        <div>
          <h3 id="image-reconciliation-title" className={styles.fieldLabel}>
            {messages.reconciliationTitle}
          </h3>
          <p className={styles.fieldHelp}>{messages.reconciliationHelp}</p>
        </div>
        <div className={styles.imageZoomControls} aria-label={messages.zoomControlsLabel}>
          <button type="button" className={styles.smallBtn} onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom === MIN_ZOOM} aria-label={messages.zoomOutLabel} data-testid="image-zoom-out">
            −
          </button>
          <span aria-live="polite" data-testid="image-zoom-value">{Math.round(zoom * 100)}%</span>
          <button type="button" className={styles.smallBtn} onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom === MAX_ZOOM} aria-label={messages.zoomInLabel} data-testid="image-zoom-in">
            +
          </button>
          <button type="button" className={styles.smallBtn} onClick={resetView} disabled={zoom === MIN_ZOOM && offset.x === 0 && offset.y === 0} aria-label={messages.resetZoomLabel} data-testid="image-zoom-reset">
            {messages.resetZoomLabel}
          </button>
        </div>
      </div>

      <div
        className={styles.imageSourceTabs}
        role="tablist"
        aria-label={messages.imageSourceLabel}
        aria-hidden={isDesktop && hasOriginal ? true : undefined}
      >
        <button
          ref={originalTabRef}
          type="button"
          role="tab"
          id="image-tab-original"
          aria-controls="image-panel-original"
          aria-selected={effectiveSource === "original"}
          tabIndex={effectiveSource === "original" ? 0 : -1}
          disabled={!hasOriginal}
          className={`${styles.imageSourceTab} ${effectiveSource === "original" ? styles.imageSourceTabActive : ""}`}
          onClick={() => selectSource("original")}
          onKeyDown={handleTabKeyDown}
          data-testid="image-source-original"
        >
          {messages.originalImageLabel}
        </button>
        <button
          ref={processedTabRef}
          type="button"
          role="tab"
          id="image-tab-processed"
          aria-controls="image-panel-processed"
          aria-selected={effectiveSource === "processed"}
          tabIndex={effectiveSource === "processed" ? 0 : -1}
          disabled={!processedPreviewUrl}
          className={`${styles.imageSourceTab} ${effectiveSource === "processed" ? styles.imageSourceTabActive : ""}`}
          onClick={() => selectSource("processed")}
          onKeyDown={handleTabKeyDown}
          data-testid="image-source-processed"
        >
          {messages.processedImageLabel}
        </button>
      </div>

      <div className={styles.imageReconciliationPanels}>
        {(hasOriginal ? ["original", "processed"] : ["processed"]).map((source) => {
          const typedSource = source as ImageSource;
          const url = typedSource === "original" ? originalPreviewUrl : processedPreviewUrl;
          const isActive = typedSource === effectiveSource;
          const isPanelVisible = (isDesktop && hasOriginal) || isActive;
          return (
            <div
              key={typedSource}
              id={`image-panel-${typedSource}`}
              className={`${styles.imageReconciliationPanel} ${isActive ? styles.imageReconciliationPanelActive : ""}`}
              role="tabpanel"
              aria-labelledby={`image-tab-${typedSource}`}
              aria-hidden={!isPanelVisible}
              hidden={!isPanelVisible}
              data-testid={`image-panel-${typedSource}`}
            >
              <p id={`image-source-label-${typedSource}`} className={styles.imageSourceLabel}>
                {typedSource === "original" ? messages.originalImageLabel : messages.processedImageLabel}
              </p>
              {url ? (
                <div
                  ref={registerViewportRef(typedSource)}
                  className={styles.imageZoomViewport}
                  tabIndex={0}
                  role="region"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={stopDragging}
                  onPointerCancel={stopDragging}
                  onPointerLeave={stopDragging}
                  onKeyDown={handleViewportKeyDown}
                  style={{ cursor: zoom > MIN_ZOOM ? "grab" : "default" }}
                  aria-label={messages.zoomHelp}
                  data-testid={`image-viewport-${typedSource}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={typedSource === "original" ? messages.originalImageLabel : messages.processedImageLabel}
                    className={styles.imageZoomed}
                    style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
                    draggable={false}
                  />
                </div>
              ) : (
                <p className={styles.infoBoxBody}>{typedSource === "original" ? messages.originalImageUnavailable : messages.processedImageUnavailable}</p>
              )}
            </div>
          );
        })}
      </div>
      <p className={styles.imageRetentionNote}>{messages.imageRetentionNote}</p>
    </section>
  );
}
