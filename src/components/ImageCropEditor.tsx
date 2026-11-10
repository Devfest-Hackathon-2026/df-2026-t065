"use client";

import React, { useEffect, useRef, useState } from "react";
import type { UiMessages } from "@/client/i18n";
import {
  applyDragToCropRect,
  applyKeyboardStepToCropRect,
  areCropRectsEqual,
  clampCropRect,
  clientDeltaToImageDelta,
  computeCropAreaPercent,
  computeDisplayedImageBox,
  createFullCropRect,
  isFullCropRect,
  type CropArrowKey,
  type CropHandle,
  type DisplayedImageBox,
  type PixelCropRect,
} from "@/client/imageCropGeometry";
import styles from "./AllergyBridgeApp.module.css";

export type ImageCropEditorProps = {
  messages: UiMessages;
  sourcePreviewUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  draftCrop: PixelCropRect;
  appliedCrop: PixelCropRect | null;
  isCropped: boolean;
  isEditorOpen: boolean;
  disabled: boolean;
  isAnalyzing?: boolean;
  onChangeDraftCrop: (nextCrop: PixelCropRect) => void;
  onApplyCrop: () => void;
  onResetCrop: () => void;
  onUseOriginalImage: () => void;
  onCancelCropEdit: () => void;
  onOpenCropEditor: () => void;
};

type ActiveDragState = {
  handle: CropHandle;
  startClientX: number;
  startClientY: number;
  startRect: PixelCropRect;
  displayedBox: DisplayedImageBox;
};

const ARROW_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function ImageCropEditor({
  messages,
  sourcePreviewUrl,
  imageWidth,
  imageHeight,
  draftCrop,
  appliedCrop,
  isCropped,
  isEditorOpen,
  disabled,
  isAnalyzing = false,
  onChangeDraftCrop,
  onApplyCrop,
  onResetCrop,
  onUseOriginalImage,
  onCancelCropEdit,
  onOpenCropEditor,
}: ImageCropEditorProps) {
  const u = messages.upload;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const activeDragRef = useRef<ActiveDragState | null>(null);
  const [displayedBox, setDisplayedBox] = useState<DisplayedImageBox | null>(null);

  const safeW = Math.max(1, Math.round(imageWidth));
  const safeH = Math.max(1, Math.round(imageHeight));
  const clampedDraft = clampCropRect(draftCrop, safeW, safeH);
  const committedRect = appliedCrop ? clampCropRect(appliedCrop, safeW, safeH) : createFullCropRect(safeW, safeH);
  const hasUnappliedChange = !areCropRectsEqual(clampedDraft, committedRect);
  const isDraftFull = isFullCropRect(clampedDraft, safeW, safeH);
  const areaPercent = computeCropAreaPercent(clampedDraft, safeW, safeH);

  const measureStageImageBox = (): DisplayedImageBox | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const stageRect = stage.getBoundingClientRect();
    const box = computeDisplayedImageBox(
      {
        left: stageRect.left,
        top: stageRect.top,
        width: stageRect.width,
        height: stageRect.height,
      },
      safeW,
      safeH,
    );
    if (!box) return null;
    return box;
  };

  useEffect(() => {
    if (!isEditorOpen || !sourcePreviewUrl) return;

    const updateDisplayedBox = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const stageRect = stage.getBoundingClientRect();
      const box = computeDisplayedImageBox(
        {
          left: stageRect.left,
          top: stageRect.top,
          width: stageRect.width,
          height: stageRect.height,
        },
        safeW,
        safeH,
      );
      if (box) {
        setDisplayedBox({
          ...box,
          left: box.left - stageRect.left,
          top: box.top - stageRect.top,
        });
      }
    };

    const observer = typeof ResizeObserver === "function" && stageRef.current
      ? new ResizeObserver(updateDisplayedBox)
      : null;
    if (observer && stageRef.current) observer.observe(stageRef.current);
    window.addEventListener("resize", updateDisplayedBox);
    const frame = window.requestAnimationFrame(updateDisplayedBox);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updateDisplayedBox);
    };
  }, [isEditorOpen, sourcePreviewUrl, safeW, safeH]);

  const leftPct = (clampedDraft.x / safeW) * 100;
  const topPct = (clampedDraft.y / safeH) * 100;
  const widthPct = (clampedDraft.width / safeW) * 100;
  const heightPct = (clampedDraft.height / safeH) * 100;

  useEffect(() => {
    if (disabled || !isEditorOpen) {
      activeDragRef.current = null;
    }
  }, [disabled, isEditorOpen, safeW, safeH]);

  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      const drag = activeDragRef.current;
      if (!drag || disabled) return;
      const { deltaX, deltaY } = clientDeltaToImageDelta(
        e.clientX - drag.startClientX,
        e.clientY - drag.startClientY,
        drag.displayedBox,
        safeW,
        safeH,
      );
      const next = applyDragToCropRect({
        startRect: drag.startRect,
        handle: drag.handle,
        deltaX,
        deltaY,
        imageWidth: safeW,
        imageHeight: safeH,
      });
      onChangeDraftCrop(next);
    };

    const handleWindowTouchMove = (e: TouchEvent) => {
      const drag = activeDragRef.current;
      if (!drag || disabled || e.touches.length === 0) return;
      const touch = e.touches[0]!;
      if (e.cancelable) {
        e.preventDefault();
      }
      const { deltaX, deltaY } = clientDeltaToImageDelta(
        touch.clientX - drag.startClientX,
        touch.clientY - drag.startClientY,
        drag.displayedBox,
        safeW,
        safeH,
      );
      const next = applyDragToCropRect({
        startRect: drag.startRect,
        handle: drag.handle,
        deltaX,
        deltaY,
        imageWidth: safeW,
        imageHeight: safeH,
      });
      onChangeDraftCrop(next);
    };

    const stopDrag = () => {
      activeDragRef.current = null;
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    window.addEventListener("touchmove", handleWindowTouchMove, { passive: false });
    window.addEventListener("touchend", stopDrag);
    window.addEventListener("touchcancel", stopDrag);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      window.removeEventListener("touchmove", handleWindowTouchMove);
      window.removeEventListener("touchend", stopDrag);
      window.removeEventListener("touchcancel", stopDrag);
    };
  }, [disabled, safeW, safeH, onChangeDraftCrop]);

  const measureDisplayedBox = (): DisplayedImageBox | null => {
    return measureStageImageBox();
  };

  const beginDrag = (handle: CropHandle, clientX: number, clientY: number) => {
    if (disabled) return;
    const displayedBox = measureDisplayedBox();
    if (!displayedBox) return;
    activeDragRef.current = {
      handle,
      startClientX: clientX,
      startClientY: clientY,
      startRect: clampedDraft,
      displayedBox,
    };
  };

  const handlePointerDown = (e: React.PointerEvent, handle: CropHandle) => {
    if (disabled) return;
    e.stopPropagation();
    beginDrag(handle, e.clientX, e.clientY);
  };

  const handleTouchStart = (e: React.TouchEvent, handle: CropHandle) => {
    if (disabled || e.touches.length === 0) return;
    e.stopPropagation();
    const touch = e.touches[0]!;
    beginDrag(handle, touch.clientX, touch.clientY);
  };

  const handleKeyDown = (e: React.KeyboardEvent, handle: CropHandle) => {
    if (disabled) return;
    if (!ARROW_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const next = applyKeyboardStepToCropRect({
      rect: clampedDraft,
      handle,
      key: e.key as CropArrowKey,
      shiftKey: e.shiftKey,
      imageWidth: safeW,
      imageHeight: safeH,
    });
    onChangeDraftCrop(next);
  };

  const summaryText = u.cropSelectionSummary({
    x: clampedDraft.x,
    y: clampedDraft.y,
    width: clampedDraft.width,
    height: clampedDraft.height,
    areaPercent,
    isCropped,
    hasUnappliedChange,
  });
  const imageLayerStyle = displayedBox
    ? {
        left: `${displayedBox.left}px`,
        top: `${displayedBox.top}px`,
        width: `${displayedBox.width}px`,
        height: `${displayedBox.height}px`,
      }
    : { left: 0, top: 0, width: "100%", height: "100%" };

  return (
    <div
      className={styles.cropEditorCard}
      role="region"
      aria-labelledby="crop-editor-title"
      data-testid="image-crop-editor"
      data-is-cropped={isCropped ? "true" : "false"}
      data-has-unapplied-crop={hasUnappliedChange ? "true" : "false"}
    >
      <div className={styles.allergenHeaderRow}>
        <h3 id="crop-editor-title" className={styles.fieldLabel} style={{ marginBottom: 0 }}>
          {u.cropSectionTitle}
        </h3>
        {!isEditorOpen && (
          <button
            type="button"
            onClick={onOpenCropEditor}
            disabled={disabled}
            className={styles.smallBtn}
            data-testid="open-crop-editor-btn"
          >
            {u.openCropEditorBtn}
          </button>
        )}
      </div>

      <p className={styles.fieldHelp}>{u.cropSectionHelp}</p>

      {/* Mandatory Safety Warning: Risk of cutting off notes/footnotes outside the cropped region */}
      <div className={styles.cropSafetyWarning} role="note" data-testid="crop-safety-warning">
        <p className={styles.cropSafetyWarningTitle}>[!] {u.cropSafetyWarningTitle}</p>
        <p className={styles.cropSafetyWarningBody}>{u.cropSafetyWarningBody}</p>
      </div>

      {/* Screen-reader live summary of current crop coordinates and state */}
      <div
        className={styles.cropSummaryBar}
        role="status"
        aria-live="polite"
        data-testid="crop-selection-summary"
        data-crop-x={clampedDraft.x}
        data-crop-y={clampedDraft.y}
        data-crop-width={clampedDraft.width}
        data-crop-height={clampedDraft.height}
      >
        {summaryText}
      </div>

      {isEditorOpen ? (
        <>
          <p className={styles.cropKeyboardHelp} data-testid="crop-keyboard-help">
            {u.cropKeyboardHelp}
          </p>

          {sourcePreviewUrl && (
            <div className={styles.cropStageViewport} data-testid="crop-stage-viewport">
              <div
                ref={stageRef}
                className={styles.cropStageContainer}
                data-testid="crop-stage"
                data-image-width={safeW}
                data-image-height={safeH}
              >
                <div className={styles.cropImageLayer} style={imageLayerStyle} data-testid="crop-image-layer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={sourcePreviewUrl}
                    alt={u.cropSectionTitle}
                    className={styles.cropSourceImage}
                    draggable={false}
                    data-testid="crop-source-img"
                  />

                  {/* Outside-of-selection dim masks */}
                  <div
                    className={styles.cropMaskOverlay}
                    style={{ left: 0, top: 0, width: "100%", height: `${topPct}%` }}
                    aria-hidden="true"
                  />
                  <div
                    className={styles.cropMaskOverlay}
                    style={{
                      left: 0,
                      top: `${topPct + heightPct}%`,
                      width: "100%",
                      height: `${Math.max(0, 100 - (topPct + heightPct))}%`,
                    }}
                    aria-hidden="true"
                  />
                  <div
                    className={styles.cropMaskOverlay}
                    style={{
                      left: 0,
                      top: `${topPct}%`,
                      width: `${leftPct}%`,
                      height: `${heightPct}%`,
                    }}
                    aria-hidden="true"
                  />
                  <div
                    className={styles.cropMaskOverlay}
                    style={{
                      left: `${leftPct + widthPct}%`,
                      top: `${topPct}%`,
                      width: `${Math.max(0, 100 - (leftPct + widthPct))}%`,
                      height: `${heightPct}%`,
                    }}
                    aria-hidden="true"
                  />

                  {/* Interactive Selection Frame + 4 Corner Handles */}
                  <div
                    role="group"
                    tabIndex={disabled ? -1 : 0}
                    aria-label={u.cropBoxAriaLabel}
                    onPointerDown={(e) => handlePointerDown(e, "move")}
                    onTouchStart={(e) => handleTouchStart(e, "move")}
                    onKeyDown={(e) => handleKeyDown(e, "move")}
                    className={styles.cropSelectionBox}
                    style={{
                      left: `${leftPct}%`,
                      top: `${topPct}%`,
                      width: `${widthPct}%`,
                      height: `${heightPct}%`,
                    }}
                    data-testid="crop-selection-box"
                  >
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={u.cropHandleLabels.nw}
                    onPointerDown={(e) => handlePointerDown(e, "nw")}
                    onTouchStart={(e) => handleTouchStart(e, "nw")}
                    onKeyDown={(e) => handleKeyDown(e, "nw")}
                    className={`${styles.cropHandleBtn} ${styles.cropHandleNw}`}
                    data-testid="crop-handle-nw"
                  >
                    <span className={styles.cropHandleVisual} aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={u.cropHandleLabels.ne}
                    onPointerDown={(e) => handlePointerDown(e, "ne")}
                    onTouchStart={(e) => handleTouchStart(e, "ne")}
                    onKeyDown={(e) => handleKeyDown(e, "ne")}
                    className={`${styles.cropHandleBtn} ${styles.cropHandleNe}`}
                    data-testid="crop-handle-ne"
                  >
                    <span className={styles.cropHandleVisual} aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={u.cropHandleLabels.sw}
                    onPointerDown={(e) => handlePointerDown(e, "sw")}
                    onTouchStart={(e) => handleTouchStart(e, "sw")}
                    onKeyDown={(e) => handleKeyDown(e, "sw")}
                    className={`${styles.cropHandleBtn} ${styles.cropHandleSw}`}
                    data-testid="crop-handle-sw"
                  >
                    <span className={styles.cropHandleVisual} aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={u.cropHandleLabels.se}
                    onPointerDown={(e) => handlePointerDown(e, "se")}
                    onTouchStart={(e) => handleTouchStart(e, "se")}
                    onKeyDown={(e) => handleKeyDown(e, "se")}
                    className={`${styles.cropHandleBtn} ${styles.cropHandleSe}`}
                    data-testid="crop-handle-se"
                  >
                    <span className={styles.cropHandleVisual} aria-hidden="true" />
                  </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {hasUnappliedChange && (
            <p className={styles.unappliedCropBanner} role="alert" data-testid="unapplied-crop-notice">
              {u.unappliedCropNotice}
            </p>
          )}

          <div className={styles.cropActionsRow}>
            <button
              type="button"
              onClick={onApplyCrop}
              disabled={disabled || (!hasUnappliedChange && (isCropped || isDraftFull))}
              className={styles.cropActionBtnPrimary}
              data-testid="apply-crop-btn"
            >
              {u.applyCropBtn}
            </button>

            <button
              type="button"
              onClick={onResetCrop}
              disabled={disabled || (isDraftFull && !isCropped)}
              className={styles.cropActionBtnSecondary}
              data-testid="reset-crop-btn"
            >
              {u.resetCropBtn}
            </button>

            <button
              type="button"
              onClick={onUseOriginalImage}
              disabled={disabled}
              className={styles.cropActionBtnSecondary}
              data-testid="use-original-image-btn"
            >
              {u.useOriginalImageBtn}
            </button>

            <button
              type="button"
              onClick={onCancelCropEdit}
              disabled={isAnalyzing}
              className={styles.cropActionBtnSecondary}
              data-testid="cancel-crop-edit-btn"
            >
              {u.cancelCropEditBtn}
            </button>
          </div>
        </>
      ) : (
        <p className={styles.fieldHelp} style={{ marginBottom: 0 }} data-testid="using-original-image-notice">
          {isCropped ? u.croppedBadge : u.usingOriginalImageNotice}
        </p>
      )}
    </div>
  );
}
