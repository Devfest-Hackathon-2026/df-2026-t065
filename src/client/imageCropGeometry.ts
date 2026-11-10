export type PixelCropRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type CropHandle = "nw" | "ne" | "sw" | "se" | "move";

export type CropArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export type BoxRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type DisplayedImageBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
};

export const DEFAULT_MIN_CROP_EDGE_PX = 32;

/**
 * Computes minimum crop width and height in upright image pixels.
 * Adapts safely to small or extreme-aspect-ratio images so cropping never exceeds image bounds.
 */
export function getMinCropSize(
  imageWidth: number,
  imageHeight: number,
  preferredMinEdgePx: number = DEFAULT_MIN_CROP_EDGE_PX,
): { minWidth: number; minHeight: number } {
  const safeW = Math.max(1, Math.round(Number.isFinite(imageWidth) ? imageWidth : 1));
  const safeH = Math.max(1, Math.round(Number.isFinite(imageHeight) ? imageHeight : 1));
  const safePref = Math.max(1, Math.round(Number.isFinite(preferredMinEdgePx) ? preferredMinEdgePx : DEFAULT_MIN_CROP_EDGE_PX));

  const minWidth = Math.max(1, Math.min(safeW, safePref, Math.max(1, Math.floor(safeW * 0.25))));
  const minHeight = Math.max(1, Math.min(safeH, safePref, Math.max(1, Math.floor(safeH * 0.25))));
  return { minWidth, minHeight };
}

/**
 * Creates a crop rectangle covering 100% of the upright image dimensions.
 */
export function createFullCropRect(imageWidth: number, imageHeight: number): PixelCropRect {
  const safeW = Math.max(1, Math.round(Number.isFinite(imageWidth) ? imageWidth : 1));
  const safeH = Math.max(1, Math.round(Number.isFinite(imageHeight) ? imageHeight : 1));
  return { x: 0, y: 0, width: safeW, height: safeH };
}

/**
 * Clamps an arbitrary crop rectangle into valid integer upright image coordinates.
 */
export function clampCropRect(
  rect: PixelCropRect,
  imageWidth: number,
  imageHeight: number,
): PixelCropRect {
  const safeW = Math.max(1, Math.round(Number.isFinite(imageWidth) ? imageWidth : 1));
  const safeH = Math.max(1, Math.round(Number.isFinite(imageHeight) ? imageHeight : 1));
  const { minWidth, minHeight } = getMinCropSize(safeW, safeH);

  const rawW = Number.isFinite(rect.width) ? Math.round(rect.width) : safeW;
  const rawH = Number.isFinite(rect.height) ? Math.round(rect.height) : safeH;
  const width = Math.min(safeW, Math.max(minWidth, rawW));
  const height = Math.min(safeH, Math.max(minHeight, rawH));

  const rawX = Number.isFinite(rect.x) ? Math.round(rect.x) : 0;
  const rawY = Number.isFinite(rect.y) ? Math.round(rect.y) : 0;
  const x = Math.min(safeW - width, Math.max(0, rawX));
  const y = Math.min(safeH - height, Math.max(0, rawY));

  return { x, y, width, height };
}

/**
 * Returns true if the crop rectangle covers the entire upright image.
 */
export function isFullCropRect(
  rect: PixelCropRect | null | undefined,
  imageWidth: number,
  imageHeight: number,
): boolean {
  if (!rect) return true;
  const safeW = Math.max(1, Math.round(imageWidth));
  const safeH = Math.max(1, Math.round(imageHeight));
  return (
    Math.round(rect.x) === 0 &&
    Math.round(rect.y) === 0 &&
    Math.round(rect.width) === safeW &&
    Math.round(rect.height) === safeH
  );
}

/**
 * Returns true if two crop rectangles have identical integer coordinates.
 */
export function areCropRectsEqual(
  a: PixelCropRect | null | undefined,
  b: PixelCropRect | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/**
 * Computes the percentage of the image area covered by the crop rectangle (1..100).
 */
export function computeCropAreaPercent(
  rect: PixelCropRect,
  imageWidth: number,
  imageHeight: number,
): number {
  const total = Math.max(1, imageWidth * imageHeight);
  const clamped = clampCropRect(rect, imageWidth, imageHeight);
  const ratio = (clamped.width * clamped.height) / total;
  return Math.min(100, Math.max(1, Math.round(ratio * 100)));
}

/**
 * Computes the actual rendered image content box inside a CSS container that uses `object-fit: contain`.
 * Accounts for letterboxing/pillarboxing, responsive viewport scaling, and arbitrary aspect ratios.
 */
export function computeDisplayedImageBox(
  containerRect: BoxRect,
  imageWidth: number,
  imageHeight: number,
): DisplayedImageBox | null {
  if (
    !Number.isFinite(containerRect.left) ||
    !Number.isFinite(containerRect.top) ||
    !Number.isFinite(containerRect.width) ||
    !Number.isFinite(containerRect.height) ||
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    containerRect.width <= 0 ||
    containerRect.height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(containerRect.width / imageWidth, containerRect.height / imageHeight);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const left = containerRect.left + (containerRect.width - width) / 2;
  const top = containerRect.top + (containerRect.height - height) / 2;

  return { left, top, width, height, scale };
}

/**
 * Converts a viewport CSS coordinate `(clientX, clientY)` into upright image pixel coordinates `(x, y)`
 * using the rendered `DisplayedImageBox`. Never confuses CSS display pixels with image pixels.
 */
export function clientPointToImagePoint(
  clientX: number,
  clientY: number,
  displayedBox: DisplayedImageBox,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  const safeW = Math.max(1, Math.round(imageWidth));
  const safeH = Math.max(1, Math.round(imageHeight));
  const relX = displayedBox.width > 0 ? (clientX - displayedBox.left) / displayedBox.width : 0;
  const relY = displayedBox.height > 0 ? (clientY - displayedBox.top) / displayedBox.height : 0;
  const clampedX = Math.min(1, Math.max(0, Number.isFinite(relX) ? relX : 0));
  const clampedY = Math.min(1, Math.max(0, Number.isFinite(relY) ? relY : 0));

  return {
    x: Math.round(clampedX * safeW),
    y: Math.round(clampedY * safeH),
  };
}

/**
 * Converts a pointer displacement `(deltaClientX, deltaClientY)` in CSS pixels into image pixel deltas.
 */
export function clientDeltaToImageDelta(
  deltaClientX: number,
  deltaClientY: number,
  displayedBox: DisplayedImageBox,
  imageWidth: number,
  imageHeight: number,
): { deltaX: number; deltaY: number } {
  const safeW = Math.max(1, Math.round(imageWidth));
  const safeH = Math.max(1, Math.round(imageHeight));
  const deltaX = displayedBox.width > 0 ? (deltaClientX / displayedBox.width) * safeW : 0;
  const deltaY = displayedBox.height > 0 ? (deltaClientY / displayedBox.height) * safeH : 0;
  return {
    deltaX: Number.isFinite(deltaX) ? deltaX : 0,
    deltaY: Number.isFinite(deltaY) ? deltaY : 0,
  };
}

/**
 * Applies a drag or resize delta (in upright image pixel coordinates) to a starting crop rectangle.
 */
export function applyDragToCropRect(params: {
  startRect: PixelCropRect;
  handle: CropHandle;
  deltaX: number;
  deltaY: number;
  imageWidth: number;
  imageHeight: number;
}): PixelCropRect {
  const safeW = Math.max(1, Math.round(params.imageWidth));
  const safeH = Math.max(1, Math.round(params.imageHeight));
  const start = clampCropRect(params.startRect, safeW, safeH);
  const { minWidth, minHeight } = getMinCropSize(safeW, safeH);
  const dx = Number.isFinite(params.deltaX) ? params.deltaX : 0;
  const dy = Number.isFinite(params.deltaY) ? params.deltaY : 0;

  const right = start.x + start.width;
  const bottom = start.y + start.height;

  switch (params.handle) {
    case "move": {
      const nextX = Math.min(safeW - start.width, Math.max(0, Math.round(start.x + dx)));
      const nextY = Math.min(safeH - start.height, Math.max(0, Math.round(start.y + dy)));
      return { x: nextX, y: nextY, width: start.width, height: start.height };
    }
    case "nw": {
      const nextLeft = Math.min(right - minWidth, Math.max(0, Math.round(start.x + dx)));
      const nextTop = Math.min(bottom - minHeight, Math.max(0, Math.round(start.y + dy)));
      return {
        x: nextLeft,
        y: nextTop,
        width: right - nextLeft,
        height: bottom - nextTop,
      };
    }
    case "ne": {
      const nextRight = Math.min(safeW, Math.max(start.x + minWidth, Math.round(right + dx)));
      const nextTop = Math.min(bottom - minHeight, Math.max(0, Math.round(start.y + dy)));
      return {
        x: start.x,
        y: nextTop,
        width: nextRight - start.x,
        height: bottom - nextTop,
      };
    }
    case "sw": {
      const nextLeft = Math.min(right - minWidth, Math.max(0, Math.round(start.x + dx)));
      const nextBottom = Math.min(safeH, Math.max(start.y + minHeight, Math.round(bottom + dy)));
      return {
        x: nextLeft,
        y: start.y,
        width: right - nextLeft,
        height: nextBottom - start.y,
      };
    }
    case "se": {
      const nextRight = Math.min(safeW, Math.max(start.x + minWidth, Math.round(right + dx)));
      const nextBottom = Math.min(safeH, Math.max(start.y + minHeight, Math.round(bottom + dy)));
      return {
        x: start.x,
        y: start.y,
        width: nextRight - start.x,
        height: nextBottom - start.y,
      };
    }
  }
}

/**
 * Adjusts the crop rectangle via keyboard arrow keys on either a corner handle (`nw`, `ne`, `sw`, `se`)
 * or the selection frame itself (`move`). Holding Shift uses a larger step (15% vs 5%).
 */
export function applyKeyboardStepToCropRect(params: {
  rect: PixelCropRect;
  handle: CropHandle;
  key: CropArrowKey;
  shiftKey?: boolean;
  imageWidth: number;
  imageHeight: number;
}): PixelCropRect {
  const safeW = Math.max(1, Math.round(params.imageWidth));
  const safeH = Math.max(1, Math.round(params.imageHeight));
  const ratio = params.shiftKey ? 0.15 : 0.05;
  const stepX = Math.max(1, Math.round(safeW * ratio));
  const stepY = Math.max(1, Math.round(safeH * ratio));

  let deltaX = 0;
  let deltaY = 0;
  switch (params.key) {
    case "ArrowLeft":
      deltaX = -stepX;
      break;
    case "ArrowRight":
      deltaX = stepX;
      break;
    case "ArrowUp":
      deltaY = -stepY;
      break;
    case "ArrowDown":
      deltaY = stepY;
      break;
  }

  return applyDragToCropRect({
    startRect: params.rect,
    handle: params.handle,
    deltaX,
    deltaY,
    imageWidth: safeW,
    imageHeight: safeH,
  });
}
