import { IMAGE_CONSTRAINTS, type InvalidInputReason } from "@/contracts/analyze";

// Approved source limits (separate from the API's 4 MiB payload limit).
export const SOURCE_IMAGE_LIMITS = { maxBytes: 20 * 1024 * 1024, maxPixels: 16_000_000, maxEdgePx: 8192 } as const;

export const DEFAULT_MAX_EDGE_PX = 2048;
export const DEFAULT_INITIAL_QUALITY = 0.88;
export const MIN_QUALITY = 0.72;
export const MIN_EDGE_PX = 1024;

export type SupportedImageMimeType = (typeof IMAGE_CONSTRAINTS.mimeTypes)[number];

/** EXIF Orientation values 1..8 (1 = normal upright). */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type ImageDimensions = {
  width: number;
  height: number;
};

export type CropRect = {
  /** Left offset in upright reference coordinates (0 <= x < referenceWidth). */
  x: number;
  /** Top offset in upright reference coordinates (0 <= y < referenceHeight). */
  y: number;
  /** Width in upright reference coordinates (1 <= width <= referenceWidth - x). */
  width: number;
  /** Height in upright reference coordinates (1 <= height <= referenceHeight - y). */
  height: number;
  /** Upright reference width (defaults to upright source width if omitted). */
  referenceWidth?: number;
  /** Upright reference height (defaults to upright source height if omitted). */
  referenceHeight?: number;
};

export type ProcessedMenuImage = {
  blob: Blob;
  mimeType: SupportedImageMimeType;
  originalBytes: number;
  processedBytes: number;
  width: number;
  height: number;
  detectedOrientation: ExifOrientation;
  exifStripped: true;
  cropped?: boolean;
};

export type ProcessImageResult =
  | { ok: true; value: ProcessedMenuImage }
  | { ok: false; reason: InvalidInputReason };

export type CanvasContext2DLike = {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  drawImage(image: unknown, dx: number, dy: number, dWidth: number, dHeight: number): void;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: "low" | "medium" | "high";
};

export type DecodedImageSource = {
  width: number;
  height: number;
  /** True if the decoder already applied EXIF orientation to the pixel buffer. */
  orientationAlreadyApplied: boolean;
  source: unknown;
  close?: () => void;
};

export type ImageTranscodeAdapter = {
  decode: (blob: Blob, rawBytes: Uint8Array) => Promise<DecodedImageSource>;
  renderToBlob: (params: {
    decoded: DecodedImageSource;
    canvasWidth: number;
    canvasHeight: number;
    drawWidth: number;
    drawHeight: number;
    orientationToApply: ExifOrientation;
    mimeType: SupportedImageMimeType;
    quality: number;
    cropOffsetX?: number;
    cropOffsetY?: number;
  }) => Promise<Blob>;
};

export type ProcessImageOptions = {
  maxEdgePx?: number;
  initialQuality?: number;
  maxBytes?: number;
  adapter?: ImageTranscodeAdapter;
  crop?: CropRect;
};

export function isSupportedImageMimeType(mime: string): mime is SupportedImageMimeType {
  return (IMAGE_CONSTRAINTS.mimeTypes as readonly string[]).includes(mime);
}

/**
 * Sniffs the actual image MIME type from magic bytes (JPEG, PNG, WebP).
 * Returns null if the byte signature does not match any supported format.
 */
export function sniffImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return null;
}

/** Read dimensions before allocating a decoded pixel buffer. Malformed headers fail closed. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = sniffImageMimeType(bytes);
  if (mime === "image/png") {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (marker !== undefined && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }
  if (mime === "image/webp") {
    const end = view.getUint32(4, true) + 8;
    if (end !== bytes.length) return null;
    let extended: ImageDimensions | null = null;
    const checked = (dimensions: ImageDimensions) => !extended || (extended.width === dimensions.width && extended.height === dimensions.height) ? dimensions : null;
    let offset = 12;
    while (offset + 8 <= end) {
      const kind = view.getUint32(offset);
      const size = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (data + size > end) return null;
      if (kind === 0x56503858 && size === 10) { // VP8X
        // Animated inputs can multiply decoder work independently of dimensions.
        if (bytes[data]! & 0x02) return null;
        const u24 = (i: number) => bytes[i]! + bytes[i + 1]! * 256 + bytes[i + 2]! * 65536;
        extended = { width: u24(data + 4) + 1, height: u24(data + 7) + 1 };
      }
      if (kind === 0x56503820 && size >= 10) { // VP8 lossy key frame
        if (bytes[data]! & 1 || (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a)) return null;
        return checked({ width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff });
      }
      if (kind === 0x5650384c && size >= 5 && bytes[data] === 0x2f) { // VP8L
        const bits = view.getUint32(data + 1, true);
        return checked({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
      }
      offset = data + size + (size % 2);
    }
  }
  return null;
}

function dimensionsWithinSourceLimits({ width, height }: ImageDimensions): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= SOURCE_IMAGE_LIMITS.maxEdgePx && height <= SOURCE_IMAGE_LIMITS.maxEdgePx &&
    width * height <= SOURCE_IMAGE_LIMITS.maxPixels;
}

/**
 * Reads the EXIF Orientation tag (0x0112) from a JPEG byte stream.
 * Returns 1 (normal) if not a JPEG, no EXIF APP1 segment exists, or tag is absent/invalid.
 */
export function readJpegExifOrientation(bytes: Uint8Array): ExifOrientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return 1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    // SOS (Start of Scan) or EOI (End of Image)
    if (marker === 0xda || marker === 0xd9) break;
    // Standalone markers without length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = view.getUint16(offset + 2, false);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;

    // APP1 marker (0xFFE1) with "Exif\0\0" header
    if (
      marker === 0xe1 &&
      segmentLength >= 14 &&
      bytes[offset + 4] === 0x45 && // 'E'
      bytes[offset + 5] === 0x78 && // 'x'
      bytes[offset + 6] === 0x69 && // 'i'
      bytes[offset + 7] === 0x66 && // 'f'
      bytes[offset + 8] === 0x00 &&
      bytes[offset + 9] === 0x00
    ) {
      const tiffStart = offset + 10;
      const segmentEnd = offset + 2 + segmentLength;
      if (tiffStart + 8 > segmentEnd) return 1;

      const byteOrder = view.getUint16(tiffStart, false);
      let littleEndian: boolean;
      if (byteOrder === 0x4949) {
        littleEndian = true;
      } else if (byteOrder === 0x4d4d) {
        littleEndian = false;
      } else {
        return 1;
      }

      if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return 1;
      const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
      const ifd0Start = tiffStart + ifd0Offset;
      if (ifd0Start + 2 > segmentEnd) return 1;

      const entryCount = view.getUint16(ifd0Start, littleEndian);
      for (let i = 0; i < entryCount; i++) {
        const entryOffset = ifd0Start + 2 + i * 12;
        if (entryOffset + 12 > segmentEnd) break;
        const tag = view.getUint16(entryOffset, littleEndian);
        if (tag === 0x0112) {
          const orientation = view.getUint16(entryOffset + 8, littleEndian);
          if (orientation >= 1 && orientation <= 8) {
            return orientation as ExifOrientation;
          }
          return 1;
        }
      }
      return 1;
    }

    offset += 2 + segmentLength;
  }

  return 1;
}

/**
 * Checks whether a JPEG, PNG, or WebP byte stream contains EXIF metadata segments/chunks.
 */
export function hasExifMetadata(bytes: Uint8Array): boolean {
  // 1. JPEG check (SOI 0xFFD8 -> APP1 0xFFE1 with "Exif\0\0" or XMP)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = view.getUint16(offset + 2, false);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
      if (
        marker === 0xe1 &&
        segmentLength >= 8 &&
        bytes[offset + 4] === 0x45 &&
        bytes[offset + 5] === 0x78 &&
        bytes[offset + 6] === 0x69 &&
        bytes[offset + 7] === 0x66
      ) {
        return true;
      }
      offset += 2 + segmentLength;
    }
    return false;
  }

  // 2. PNG check (8-byte signature -> eXIf chunk)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const type0 = bytes[offset + 4];
      const type1 = bytes[offset + 5];
      const type2 = bytes[offset + 6];
      const type3 = bytes[offset + 7];
      // "eXIf"
      if (type0 === 0x65 && type1 === 0x58 && type2 === 0x49 && type3 === 0x66) {
        return true;
      }
      offset += 12 + length;
    }
    return false;
  }

  // 3. WebP check ("RIFF" .... "WEBP" -> "EXIF" chunk)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkSize = view.getUint32(offset + 4, true);
      if (
        bytes[offset] === 0x45 && // E
        bytes[offset + 1] === 0x58 && // X
        bytes[offset + 2] === 0x49 && // I
        bytes[offset + 3] === 0x46 // F
      ) {
        return true;
      }
      const paddedSize = chunkSize + (chunkSize % 2);
      offset += 8 + paddedSize;
    }
    return false;
  }

  return false;
}

/**
 * Strips EXIF / metadata segments from JPEG, PNG, or WebP byte arrays.
 * Used as a defense-in-depth guarantee after canvas re-encoding.
 */
export function stripExifMetadataBytes(bytes: Uint8Array): Uint8Array {
  // 1. JPEG: remove APP1..APP15 (0xFFE1..0xFFEF) except JFIF APP0 (0xFFE0), and COM (0xFFFE)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
    let offset = 2;

    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        chunks.push(bytes.subarray(offset));
        break;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xda) {
        // Start of Scan: copy rest of file (compressed image data)
        chunks.push(bytes.subarray(offset));
        break;
      }
      if (marker === 0xd9) {
        chunks.push(bytes.subarray(offset, offset + 2));
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        chunks.push(bytes.subarray(offset, offset + 2));
        offset += 2;
        continue;
      }
      const segmentLength = view.getUint16(offset + 2, false);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
        chunks.push(bytes.subarray(offset));
        break;
      }
      const segmentEnd = offset + 2 + segmentLength;
      const isMetadataSegment = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
      if (!isMetadataSegment) {
        chunks.push(bytes.subarray(offset, segmentEnd));
      }
      offset = segmentEnd;
    }

    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // 2. PNG: remove eXIf, tEXt, zTXt, iTXt chunks
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const chunkTotal = 12 + length;
      if (offset + chunkTotal > bytes.length) {
        chunks.push(bytes.subarray(offset));
        break;
      }
      const type = String.fromCharCode(
        bytes[offset + 4]!,
        bytes[offset + 5]!,
        bytes[offset + 6]!,
        bytes[offset + 7]!,
      );
      if (type !== "eXIf" && type !== "tEXt" && type !== "zTXt" && type !== "iTXt") {
        chunks.push(bytes.subarray(offset, offset + chunkTotal));
      }
      offset += chunkTotal;
    }
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // 3. WebP: remove EXIF and XMP chunks
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks: Uint8Array[] = [bytes.subarray(0, 12)];
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkSize = view.getUint32(offset + 4, true);
      const paddedSize = chunkSize + (chunkSize % 2);
      const chunkTotal = 8 + paddedSize;
      if (offset + chunkTotal > bytes.length) {
        chunks.push(bytes.subarray(offset));
        break;
      }
      const fourCC = String.fromCharCode(
        bytes[offset]!,
        bytes[offset + 1]!,
        bytes[offset + 2]!,
        bytes[offset + 3]!,
      );
      if (fourCC !== "EXIF" && fourCC !== "XMP ") {
        chunks.push(bytes.subarray(offset, offset + chunkTotal));
      }
      offset += chunkTotal;
    }
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    if (out.length >= 8) {
      new DataView(out.buffer).setUint32(4, out.length - 8, true);
    }
    return out;
  }

  return bytes;
}

/**
 * Returns true if the EXIF orientation swaps width and height (90° or 270° rotation).
 */
export function doesOrientationSwapDimensions(orientation: ExifOrientation): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * Computes scaled draw dimensions (in unrotated source coordinate space) and
 * final upright canvas dimensions (after applying EXIF orientation).
 */
export function computeOrientedDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxEdgePx: number,
  orientationToApply: ExifOrientation = 1,
): {
  drawWidth: number;
  drawHeight: number;
  canvasWidth: number;
  canvasHeight: number;
} {
  const safeWidth = Math.max(1, Math.round(sourceWidth));
  const safeHeight = Math.max(1, Math.round(sourceHeight));
  const longestEdge = Math.max(safeWidth, safeHeight);
  const scale = longestEdge > maxEdgePx ? maxEdgePx / longestEdge : 1;

  const drawWidth = Math.max(1, Math.round(safeWidth * scale));
  const drawHeight = Math.max(1, Math.round(safeHeight * scale));

  if (doesOrientationSwapDimensions(orientationToApply)) {
    return {
      drawWidth,
      drawHeight,
      canvasWidth: drawHeight,
      canvasHeight: drawWidth,
    };
  }
  return {
    drawWidth,
    drawHeight,
    canvasWidth: drawWidth,
    canvasHeight: drawHeight,
  };
}

/**
 * Validates and maps a CropRect (defined in upright reference coordinates) into upright source pixel coordinates.
 * Returns null if the crop parameters are invalid or out of bounds (fail-closed).
 */
export function validateAndNormalizeCropRect(
  crop: CropRect,
  uprightSourceWidth: number,
  uprightSourceHeight: number,
): { x: number; y: number; width: number; height: number; isFullImage: boolean } | null {
  if (
    !Number.isFinite(uprightSourceWidth) ||
    !Number.isFinite(uprightSourceHeight) ||
    uprightSourceWidth <= 0 ||
    uprightSourceHeight <= 0
  ) {
    return null;
  }

  const refW = crop.referenceWidth ?? uprightSourceWidth;
  const refH = crop.referenceHeight ?? uprightSourceHeight;
  if (
    !Number.isFinite(refW) ||
    !Number.isFinite(refH) ||
    refW <= 0 ||
    refH <= 0 ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height)
  ) {
    return null;
  }

  if (
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x < -0.5 ||
    crop.y < -0.5 ||
    crop.x + crop.width > refW + 0.5 ||
    crop.y + crop.height > refH + 0.5
  ) {
    return null;
  }

  const clampedRefX = Math.max(0, Math.min(refW - 1, crop.x));
  const clampedRefY = Math.max(0, Math.min(refH - 1, crop.y));
  const clampedRefW = Math.max(1, Math.min(refW - clampedRefX, crop.width));
  const clampedRefH = Math.max(1, Math.min(refH - clampedRefY, crop.height));

  const x = Math.max(0, Math.min(uprightSourceWidth - 1, Math.round((clampedRefX / refW) * uprightSourceWidth)));
  const y = Math.max(0, Math.min(uprightSourceHeight - 1, Math.round((clampedRefY / refH) * uprightSourceHeight)));
  const width = Math.max(1, Math.min(uprightSourceWidth - x, Math.round((clampedRefW / refW) * uprightSourceWidth)));
  const height = Math.max(1, Math.min(uprightSourceHeight - y, Math.round((clampedRefH / refH) * uprightSourceHeight)));

  const isFullImage = x === 0 && y === 0 && width === uprightSourceWidth && height === uprightSourceHeight;
  return { x, y, width, height, isFullImage };
}

/**
 * Computes scaled draw dimensions, upright canvas dimensions, and upright crop offsets
 * so that cropping and EXIF orientation normalization happen in a single render pass without double compression.
 */
export function computeOrientedCropDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxEdgePx: number,
  orientationToApply: ExifOrientation = 1,
  normalizedCrop?: { x: number; y: number; width: number; height: number; isFullImage: boolean } | null,
): {
  drawWidth: number;
  drawHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  cropOffsetX: number;
  cropOffsetY: number;
} {
  if (!normalizedCrop || normalizedCrop.isFullImage) {
    const base = computeOrientedDimensions(sourceWidth, sourceHeight, maxEdgePx, orientationToApply);
    return { ...base, cropOffsetX: 0, cropOffsetY: 0 };
  }

  const safeSourceW = Math.max(1, Math.round(sourceWidth));
  const safeSourceH = Math.max(1, Math.round(sourceHeight));
  const cropLongestEdge = Math.max(normalizedCrop.width, normalizedCrop.height);
  const scale = cropLongestEdge > maxEdgePx ? maxEdgePx / cropLongestEdge : 1;

  const canvasWidth = Math.max(1, Math.round(normalizedCrop.width * scale));
  const canvasHeight = Math.max(1, Math.round(normalizedCrop.height * scale));
  const drawWidth = Math.max(1, Math.round(safeSourceW * scale));
  const drawHeight = Math.max(1, Math.round(safeSourceH * scale));

  const uprightDrawW = doesOrientationSwapDimensions(orientationToApply) ? drawHeight : drawWidth;
  const uprightDrawH = doesOrientationSwapDimensions(orientationToApply) ? drawWidth : drawHeight;

  const cropOffsetX = Math.min(Math.max(0, Math.round(normalizedCrop.x * scale)), Math.max(0, uprightDrawW - canvasWidth));
  const cropOffsetY = Math.min(Math.max(0, Math.round(normalizedCrop.y * scale)), Math.max(0, uprightDrawH - canvasHeight));

  return {
    drawWidth,
    drawHeight,
    canvasWidth,
    canvasHeight,
    cropOffsetX,
    cropOffsetY,
  };
}

/**
 * Applies the 2D canvas coordinate transform for the given EXIF orientation (1..8)
 * before drawing an unrotated source of size (drawWidth x drawHeight) onto a canvas
 * of size (canvasWidth x canvasHeight).
 */
export function applyExifOrientationTransform(
  ctx: CanvasContext2DLike,
  drawWidth: number,
  drawHeight: number,
  orientation: ExifOrientation,
): void {
  switch (orientation) {
    case 2:
      // Horizontal flip
      ctx.translate(drawWidth, 0);
      ctx.scale(-1, 1);
      break;
    case 3:
      // 180° rotate
      ctx.translate(drawWidth, drawHeight);
      ctx.rotate(Math.PI);
      break;
    case 4:
      // Vertical flip
      ctx.translate(0, drawHeight);
      ctx.scale(1, -1);
      break;
    case 5:
      // Transpose (90° CW + horizontal flip)
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6:
      // 90° CW rotate
      ctx.translate(drawHeight, 0);
      ctx.rotate(0.5 * Math.PI);
      break;
    case 7:
      // Transverse (90° CCW + horizontal flip)
      ctx.translate(drawHeight, drawWidth);
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(-1, 1);
      break;
    case 8:
      // 90° CCW rotate
      ctx.translate(0, drawWidth);
      ctx.rotate(-0.5 * Math.PI);
      break;
    case 1:
    default:
      break;
  }
}

/**
 * Default browser implementation of ImageTranscodeAdapter using createImageBitmap + <canvas>.
 */
export const browserCanvasAdapter: ImageTranscodeAdapter = {
  async decode(blob: Blob): Promise<DecodedImageSource> {
    if (typeof createImageBitmap === "function") {
      // The default "from-image" mode applies EXIF orientation. Treat the decoded
      // bitmap as upright and never apply the same orientation in the canvas pass.
      const bitmap = await createImageBitmap(blob);
      return {
        width: bitmap.width,
        height: bitmap.height,
        orientationAlreadyApplied: true,
        source: bitmap,
        close: () => bitmap.close(),
      };
    }

    if (typeof document !== "undefined" && typeof URL !== "undefined") {
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error("Failed to decode image element"));
          el.src = objectUrl;
        });
        return {
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          // HTMLImageElement is the single orientation authority. Do not apply EXIF again.
          orientationAlreadyApplied: true,
          source: img,
        };
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    throw new Error("HTMLImageElement image decoding is not available in this environment");
  },

  async renderToBlob({
    decoded,
    canvasWidth,
    canvasHeight,
    drawWidth,
    drawHeight,
    orientationToApply,
    mimeType,
    quality,
    cropOffsetX,
    cropOffsetY,
  }): Promise<Blob> {
    if (typeof document === "undefined") {
      throw new Error("HTMLCanvasElement is not available in this environment");
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Could not acquire 2D canvas context");
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.save();
      if (cropOffsetX || cropOffsetY) {
        ctx.translate(-(cropOffsetX ?? 0), -(cropOffsetY ?? 0));
      }
      applyExifOrientationTransform(ctx, drawWidth, drawHeight, orientationToApply);
      ctx.drawImage(decoded.source as CanvasImageSource, 0, 0, drawWidth, drawHeight);
      ctx.restore();

      const encodedBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), mimeType, quality);
      });
      if (!encodedBlob) {
        throw new Error("Canvas toBlob returned null");
      }
      return encodedBlob;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};

/**
 * Processes a user-selected menu image before upload:
 * 1. Validates non-empty Blob and supported MIME type (JPEG / PNG / WebP).
 * 2. Reads EXIF orientation from JPEG header so orientation is preserved accurately.
 * 3. Re-encodes through <canvas> (max edge ~2048px, quality 0.85-0.90, with optional single-pass crop)
 *    to strip all EXIF metadata and keep payload size within 4 MiB while maintaining sharp readability.
 * 4. Steps down quality/dimensions if still over 4 MiB (e.g., dense PNG converted to JPEG/WebP).
 */
export async function processMenuImage(
  file: Blob | null | undefined,
  options: ProcessImageOptions = {},
): Promise<ProcessImageResult> {
  if (!file || file.size === 0) {
    return { ok: false, reason: "image_missing" };
  }
  if (!isSupportedImageMimeType(file.type)) {
    return { ok: false, reason: "unsupported_image_type" };
  }

  if (file.size > SOURCE_IMAGE_LIMITS.maxBytes) return { ok: false, reason: "image_too_large" };
  const maxBytes = Math.min(options.maxBytes ?? IMAGE_CONSTRAINTS.maxBytes, IMAGE_CONSTRAINTS.maxBytes);
  const initialMaxEdge = options.maxEdgePx ?? DEFAULT_MAX_EDGE_PX;
  const initialQuality = options.initialQuality ?? DEFAULT_INITIAL_QUALITY;
  const adapter = options.adapter ?? browserCanvasAdapter;

  let rawBytes: Uint8Array;
  try { rawBytes = new Uint8Array(await file.arrayBuffer()); }
  catch { return { ok: false, reason: "malformed_request" }; }
  const sniffedMime = sniffImageMimeType(rawBytes);
  if (sniffedMime === null || sniffedMime !== file.type) {
    return { ok: false, reason: "unsupported_image_type" };
  }
  const dimensions = readImageDimensions(rawBytes);
  if (!dimensions) return { ok: false, reason: "unsupported_image_type" };
  if (!dimensionsWithinSourceLimits(dimensions)) return { ok: false, reason: "image_too_large" };
  const detectedOrientation = file.type === "image/jpeg" ? readJpegExifOrientation(rawBytes) : 1;

  let decoded: DecodedImageSource;
  try {
    decoded = await adapter.decode(file, rawBytes);
  } catch {
    return { ok: false, reason: "unsupported_image_type" };
  }

  try {
    if (!dimensionsWithinSourceLimits(decoded)) return { ok: false, reason: "image_too_large" };
    const orientationToApply: ExifOrientation = decoded.orientationAlreadyApplied ? 1 : detectedOrientation;
    const uprightSourceWidth = doesOrientationSwapDimensions(orientationToApply) ? decoded.height : decoded.width;
    const uprightSourceHeight = doesOrientationSwapDimensions(orientationToApply) ? decoded.width : decoded.height;

    let normalizedCrop: { x: number; y: number; width: number; height: number; isFullImage: boolean } | null = null;
    if (options.crop) {
      normalizedCrop = validateAndNormalizeCropRect(options.crop, uprightSourceWidth, uprightSourceHeight);
      if (!normalizedCrop) {
        return { ok: false, reason: "malformed_request" };
      }
    }

    // Candidate attempts: start with original format (or JPEG if PNG exceeds 4 MiB after first pass),
    // stepping down quality and max edge if necessary to fit under 4 MiB.
    const edgeSteps = [initialMaxEdge, 1600, MIN_EDGE_PX];
    const qualitySteps = [initialQuality, 0.82, MIN_QUALITY];

    for (const edge of edgeSteps) {
      const dims = computeOrientedCropDimensions(
        decoded.width,
        decoded.height,
        edge,
        orientationToApply,
        normalizedCrop,
      );

      for (const quality of qualitySteps) {
        // If input is PNG and we are past the first quality step (meaning PNG was > maxBytes),
        // switch output to image/jpeg so photographic menus compress below 4 MiB.
        const outputMime: SupportedImageMimeType =
          file.type === "image/png" && quality < initialQuality ? "image/jpeg" : (file.type as SupportedImageMimeType);

        const renderedBlob = await adapter.renderToBlob({
          decoded,
          canvasWidth: dims.canvasWidth,
          canvasHeight: dims.canvasHeight,
          drawWidth: dims.drawWidth,
          drawHeight: dims.drawHeight,
          orientationToApply,
          mimeType: outputMime,
          quality,
          ...(dims.cropOffsetX || dims.cropOffsetY
            ? { cropOffsetX: dims.cropOffsetX, cropOffsetY: dims.cropOffsetY }
            : {}),
        });

        // Defense-in-depth binary EXIF strip
        const renderedBytes = new Uint8Array(await renderedBlob.arrayBuffer());
        const cleanBytes = stripExifMetadataBytes(renderedBytes);
        const cleanBlob = new Blob([cleanBytes.buffer as ArrayBuffer], { type: renderedBlob.type || outputMime });

        if (cleanBlob.size > 0 && cleanBlob.size <= maxBytes) {
          return {
            ok: true,
            value: {
              blob: cleanBlob,
              mimeType: (cleanBlob.type || outputMime) as SupportedImageMimeType,
              originalBytes: file.size,
              processedBytes: cleanBlob.size,
              width: dims.canvasWidth,
              height: dims.canvasHeight,
              detectedOrientation,
              exifStripped: true,
              ...(normalizedCrop && !normalizedCrop.isFullImage ? { cropped: true } : {}),
            },
          };
        }

        // For lossless PNG on the first quality step that fitted under maxBytes we already returned;
        // if PNG was too big, continue loop to try JPEG encoding.
      }
    }

    return { ok: false, reason: "image_too_large" };
  } catch {
    return { ok: false, reason: "malformed_request" };
  } finally {
    decoded.close?.();
  }
}
