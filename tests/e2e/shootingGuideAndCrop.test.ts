/*
 * _notice: SYNTHETIC TEST DATA — header-only image fixtures; adapters replace pixel decoding.
 * Shooting guide & image cropping (P1). No real menu photos are used.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_CONSTRAINTS } from "@/contracts/analyze";
import { AllergyBridgeApp, type AllergyBridgeAppProps } from "@/components/AllergyBridgeApp";
import { ImageUploadSection, type ImageUploadSectionProps } from "@/components/ImageUploadSection";
import { UI_MESSAGES } from "@/client/i18n";
import {
  applyDragToCropRect,
  applyKeyboardStepToCropRect,
  areCropRectsEqual,
  clampCropRect,
  clientDeltaToImageDelta,
  clientPointToImagePoint,
  computeCropAreaPercent,
  computeDisplayedImageBox,
  createFullCropRect,
  getMinCropSize,
  isFullCropRect,
} from "@/client/imageCropGeometry";
import {
  SOURCE_IMAGE_LIMITS,
  applyExifOrientationTransform,
  browserCanvasAdapter,
  computeOrientedCropDimensions,
  doesOrientationSwapDimensions,
  hasExifMetadata,
  processMenuImage,
  validateAndNormalizeCropRect,
  type CanvasContext2DLike,
  type ExifOrientation,
  type ImageTranscodeAdapter,
  type ProcessedMenuImage,
} from "@/client/imageProcessor";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------
function pngBlob(width: number, height: number, size = 64): Blob {
  const bytes = new Uint8Array(Math.max(size, 24));
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
}

function webpBlob(width: number, height: number): Blob {
  // RIFF + "VP8L" lossless header carrying (width-1, height-1) in 14-bit fields.
  const buf = new Uint8Array(30);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, buf.length - 8, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x4c], 12);
  view.setUint32(16, 10, true);
  buf[20] = 0x2f;
  view.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
  return new Blob([buf.buffer as ArrayBuffer], { type: "image/webp" });
}

/** JPEG with SOF dimensions and an APP1 Exif segment carrying Orientation + fake GPS bytes. */
function jpegBlob(width: number, height: number, orientation: number = 1): Blob {
  const exif = [
    0x45, 0x78, 0x69, 0x66, 0, 0, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // TIFF MM, IFD0 @ 8
    0, 1, // 1 entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, (orientation >> 8) & 0xff, orientation & 0xff, 0, 0,
    0, 0, 0, 0,
    // fake "GPS" personal data bytes
    0x47, 0x50, 0x53, 0x35, 0x2e, 0x31,
  ];
  const app1Len = exif.length + 2;
  const sof = [0xff, 0xc0, 0, 8, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0];
  const bytes = [
    0xff, 0xd8,
    0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, ...exif,
    ...sof,
    0xff, 0xda, 1, 2, 3, 4, 5, 6,
    0xff, 0xd9,
  ];
  return new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/jpeg" });
}

/** Rendered output that still contains an Exif APP1 segment (must be stripped by processMenuImage). */
function renderedJpegWithExif(totalBytes = 64): Blob {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x47, 0x50, 0x53];
  const app1Len = exif.length + 2;
  const head = [0xff, 0xd8, 0xff, 0xe1, 0, app1Len, ...exif, 0xff, 0xda];
  const out = new Uint8Array(Math.max(totalBytes, head.length + 2));
  out.set(head, 0);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return new Blob([out.buffer as ArrayBuffer], { type: "image/jpeg" });
}

type RenderCall = Parameters<ImageTranscodeAdapter["renderToBlob"]>[0];

function recordingAdapter(
  decoded: { width: number; height: number; orientationAlreadyApplied?: boolean },
  outputSizes: number[] = [64],
  outputMime?: string,
) {
  const calls: RenderCall[] = [];
  let i = 0;
  const close = vi.fn();
  const adapter: ImageTranscodeAdapter = {
    decode: vi.fn(async () => ({
      width: decoded.width,
      height: decoded.height,
      orientationAlreadyApplied: decoded.orientationAlreadyApplied ?? false,
      source: {},
      close,
    })),
    renderToBlob: vi.fn(async (params: RenderCall) => {
      calls.push(params);
      const size = outputSizes[Math.min(i++, outputSizes.length - 1)]!;
      const blob = renderedJpegWithExif(size);
      return outputMime ? new Blob([await blob.arrayBuffer()], { type: outputMime }) : new Blob([await blob.arrayBuffer()], { type: params.mimeType });
    }),
  };
  return { adapter, calls, close };
}

// ---------------------------------------------------------------------------
// Affine matrix tracking context (verifies orientation + crop offset in one pass)
// ---------------------------------------------------------------------------
type Mat = [number, number, number, number, number, number]; // a b c d e f
function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function trackingCtx() {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  const ctx: CanvasContext2DLike = {
    save() {},
    restore() {},
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    rotate(a) { const c = Math.cos(a), s = Math.sin(a); m = mul(m, [c, s, -s, c, 0, 0]); },
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    drawImage() {},
  };
  const apply = (x: number, y: number) => ({
    x: Math.round((m[0] * x + m[2] * y + m[4]) * 1000) / 1000,
    y: Math.round((m[1] * x + m[3] * y + m[5]) * 1000) / 1000,
  });
  return { ctx, apply };
}
/** Standard EXIF mapping of a raw (stored) pixel to its upright position. */
function exifUpright(o: ExifOrientation, x: number, y: number, W: number, H: number) {
  switch (o) {
    case 1: return { x, y };
    case 2: return { x: W - x, y };
    case 3: return { x: W - x, y: H - y };
    case 4: return { x, y: H - y };
    case 5: return { x: y, y: x };
    case 6: return { x: H - y, y: x };
    case 7: return { x: H - y, y: W - x };
    case 8: return { x: y, y: W - x };
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function renderApp(props: AllergyBridgeAppProps = {}): string {
  return renderToStaticMarkup(React.createElement(AllergyBridgeApp, { analysisAvailable: true, ...props }));
}

function fakeProcessed(overrides: Partial<ProcessedMenuImage> = {}): ProcessedMenuImage {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xda]);
  return {
    blob: new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" }),
    mimeType: "image/jpeg",
    originalBytes: 1_000_000,
    processedBytes: 300_000,
    width: 1200,
    height: 1600,
    detectedOrientation: 1,
    exifStripped: true,
    ...overrides,
  };
}

function renderSection(lang: "ja" | "en", overrides: Partial<ImageUploadSectionProps> = {}): string {
  const noop = () => {};
  const props: ImageUploadSectionProps = {
    uiLang: lang,
    messages: UI_MESSAGES[lang],
    processedImage: null,
    previewUrl: null,
    isProcessingImage: false,
    isAnalyzing: false,
    mockScenario: "ok",
    nodeEnv: "production",
    onSelectFile: noop,
    onChangeMockScenario: noop,
    onAnalyze: noop,
    onClearImage: noop,
    onBackToSettings: noop,
    onGoToCardDirectly: noop,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(ImageUploadSection, { analysisAvailable: true, ...props }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function isAnalyzeDisabled(html: string): boolean {
  const tag = html.match(/<button[^>]*data-testid="analyze-menu-btn"[^>]*>/)?.[0] ?? "";
  return /\sdisabled=""/.test(tag);
}

// ===========================================================================
// 1. Shooting guide (JA / EN)
// ===========================================================================
describe("[1] 撮影ガイド — 日本語・英語表示", () => {
  it.each(["ja", "en"] as const)("renders the 5 guide items in %s before the camera/file buttons", (lang) => {
    const html = renderApp({
      initialStep: "upload",
      initialSettings: { userLang: lang, storeLang: lang === "ja" ? "en" : "ja", allergens: ["shrimp"] },
    });
    const u = UI_MESSAGES[lang].upload;
    expect(html).toContain('data-testid="shooting-guide-box"');
    expect(html).toContain(escapeHtml(u.shootingGuideTitle));
    expect(u.shootingGuideItems).toHaveLength(5);
    u.shootingGuideItems.forEach((item, idx) => {
      expect(html).toContain(`data-testid="shooting-guide-item-${idx}"`);
      expect(html).toContain(escapeHtml(item));
    });
    // Guide is shown before (not on top of) the capture controls, which stay enabled.
    expect(html.indexOf('data-testid="shooting-guide-box"')).toBeLessThan(html.indexOf('data-testid="camera-capture-btn"'));
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="camera-capture-btn"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="file-picker-btn"/);
  });

  it("covers the required topics and does NOT pretend multi-image analysis is supported", () => {
    const ja = UI_MESSAGES.ja.upload.shootingGuideItems.join("\n");
    const en = UI_MESSAGES.en.upload.shootingGuideItems.join("\n");
    for (const kw of ["距離", "反射", "手ぶれ", "料理名", "原材料", "注意書き", "小さい文字", "アレルゲン", "ページ"]) {
      expect(ja).toContain(kw);
    }
    for (const kw of ["readable", "glare", "shake", "dish names", "ingredients", "allergy notes", "small print", "allergen", "page"]) {
      expect(en.toLowerCase()).toContain(kw.toLowerCase());
    }
    expect(ja).toContain("1枚");
    expect(en).toContain("1 image per analysis");
    // No safety verdicts in guide text
    expect(`${ja}\n${en}`).not.toMatch(/安全です|食べられます|safe to eat|allergen[- ]free/i);
  });

  it("the guide is static markup (identical SSR output regardless of window/localStorage)", () => {
    const props: AllergyBridgeAppProps = {
      initialStep: "upload",
      initialSettings: { userLang: "ja", storeLang: "en", allergens: ["egg"] },
    };
    const server = renderApp(props);
    const prev = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
    try {
      expect(renderApp(props)).toBe(server);
    } finally {
      if (prev === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = prev;
    }
  });
});

// ===========================================================================
// 2. Crop editor UI (SSR) — safety notices, a11y, analyze gating
// ===========================================================================
describe("[2] トリミング編集UI — 安全表示・アクセシビリティ・解析ボタン制御", () => {
  it.each(["ja", "en"] as const)("shows the editor with safety warning, 4 labelled handles and live status (%s)", (lang) => {
    const html = renderApp({
      initialStep: "upload",
      initialSettings: { userLang: lang, storeLang: lang === "ja" ? "en" : "ja", allergens: ["shrimp"] },
      initialProcessedImage: fakeProcessed(),
      initialPreviewUrl: "blob:http://localhost/synthetic",
    });
    const u = UI_MESSAGES[lang].upload;
    expect(html).toContain('data-testid="image-crop-editor"');
    expect(html).toContain('data-testid="crop-safety-warning"');
    expect(html).toContain(escapeHtml(u.cropSafetyWarningTitle));
    expect(html).toContain(escapeHtml(u.cropSafetyWarningBody));
    expect(html).toContain(escapeHtml(u.cropKeyboardHelp));
    for (const h of ["nw", "ne", "sw", "se"] as const) {
      expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${escapeHtml(u.cropHandleLabels[h]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-testid="crop-handle-${h}"`));
    }
    expect(html).toMatch(/role="group" tabindex="0" aria-label="[^"]+"[^>]*data-testid="crop-selection-box"/);
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*data-testid="crop-selection-summary"/);
    expect(html).toContain('data-crop-width="1200"');
    expect(html).toContain('data-crop-height="1600"');
    for (const id of ["apply-crop-btn", "reset-crop-btn", "use-original-image-btn", "cancel-crop-edit-btn"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // Default = full image, so the uncropped path can be analyzed immediately.
    expect(isAnalyzeDisabled(html)).toBe(false);
    expect(html).not.toContain('data-testid="unapplied-crop-notice"');
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("disables analysis while a crop change is unapplied, so the analyzed image always matches the selection", () => {
    const base = fakeProcessed();
    const full = createFullCropRect(base.width, base.height);
    const html = renderSection("ja", {
      processedImage: base,
      previewUrl: "blob:x",
      baseImage: base,
      basePreviewUrl: "blob:x",
      appliedCropRect: full,
      draftCropRect: { x: 100, y: 100, width: 600, height: 800 },
      isCropEditorOpen: true,
    });
    expect(isAnalyzeDisabled(html)).toBe(true);
    expect(html).toContain('data-testid="unapplied-crop-notice"');
    expect(html).toContain('data-has-unapplied-crop="true"');
  });

  it("shows the cropped badge and the 'important info may be outside the crop' note on the analyzed preview", () => {
    const base = fakeProcessed();
    const cropped = fakeProcessed({ width: 600, height: 800, cropped: true });
    const rect = { x: 100, y: 100, width: 600, height: 800 };
    const html = renderSection("en", {
      processedImage: cropped,
      previewUrl: "blob:c",
      baseImage: base,
      basePreviewUrl: "blob:b",
      appliedCropRect: rect,
      draftCropRect: rect,
      isCropEditorOpen: false,
    });
    expect(html).toContain('data-testid="cropped-image-badge"');
    expect(html).toContain('data-testid="cropped-preview-safety-note"');
    expect(html).toContain("outside the cropped area");
    expect(html).toContain("600 × 800 px");
    expect(html).toContain('data-testid="open-crop-editor-btn"');
    expect(isAnalyzeDisabled(html)).toBe(false);
  });

  it("keeps the camera/file buttons usable during image processing so the user can switch images mid-edit", () => {
    const base = fakeProcessed();
    const html = renderSection("ja", { processedImage: base, previewUrl: "blob:x", isProcessingImage: true });
    expect(html).toContain('data-testid="cancel-image-processing-btn"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="file-picker-btn"/);
    expect(isAnalyzeDisabled(html)).toBe(true);
  });

  it("never renders safety-verdict wording in crop UI messages", () => {
    for (const lang of ["ja", "en"] as const) {
      const u = UI_MESSAGES[lang].upload;
      const text = [u.cropSectionTitle, u.cropSectionHelp, u.cropSafetyWarningBody, u.croppedBadge, u.usingOriginalImageNotice].join("\n");
      expect(text).not.toMatch(/安全です|食べられます|safe to eat|is safe\b/i);
    }
  });
});

// ===========================================================================
// 3. Coordinate conversion (CSS px vs image px, object-fit: contain, DPR)
// ===========================================================================
describe("[6] 座標変換・表示サイズ変更", () => {
  it("solves object-fit: contain letterbox (wide image) and pillarbox (tall image)", () => {
    const wide = computeDisplayedImageBox({ left: 10, top: 20, width: 300, height: 300 }, 1200, 600)!;
    expect(wide).toEqual({ left: 10, top: 95, width: 300, height: 150, scale: 0.25 });
    const tall = computeDisplayedImageBox({ left: 0, top: 0, width: 300, height: 300 }, 600, 1200)!;
    expect(tall).toEqual({ left: 75, top: 0, width: 150, height: 300, scale: 0.25 });
    expect(computeDisplayedImageBox({ left: 0, top: 0, width: 0, height: 300 }, 600, 1200)).toBeNull();
  });

  it("maps client points to image pixels (clamped to image, letterbox areas excluded)", () => {
    const box = computeDisplayedImageBox({ left: 0, top: 0, width: 300, height: 300 }, 1200, 600)!;
    expect(clientPointToImagePoint(150, 150, box, 1200, 600)).toEqual({ x: 600, y: 300 });
    expect(clientPointToImagePoint(0, 75, box, 1200, 600)).toEqual({ x: 0, y: 0 });
    expect(clientPointToImagePoint(-50, 10, box, 1200, 600)).toEqual({ x: 0, y: 0 });
    expect(clientPointToImagePoint(999, 999, box, 1200, 600)).toEqual({ x: 1200, y: 600 });
  });

  it("converts the same physical drag consistently across viewport widths (375px phone vs 760px desktop)", () => {
    const phone = computeDisplayedImageBox({ left: 0, top: 0, width: 343, height: 300 }, 2048, 1536)!;
    const desktop = computeDisplayedImageBox({ left: 0, top: 0, width: 700, height: 340 }, 2048, 1536)!;
    // Dragging by 10% of the *displayed* width moves 10% of the *image* width in both layouts.
    const p = clientDeltaToImageDelta(phone.width * 0.1, 0, phone, 2048, 1536);
    const d = clientDeltaToImageDelta(desktop.width * 0.1, 0, desktop, 2048, 1536);
    expect(Math.round(p.deltaX)).toBe(205);
    expect(Math.round(d.deltaX)).toBe(205);
  });

  it("is independent of devicePixelRatio (uses CSS-pixel client coordinates & rects only)", () => {
    // getBoundingClientRect() and pointer clientX/Y are both CSS px; DPR (1/2/3) never enters the math.
    const box = computeDisplayedImageBox({ left: 0, top: 0, width: 360, height: 300 }, 1440, 1200)!;
    const a = clientDeltaToImageDelta(36, 30, box, 1440, 1200);
    expect(a).toEqual({ deltaX: 144, deltaY: 120 });
    expect(clientDeltaToImageDelta(Number.NaN, Infinity, box, 1440, 1200)).toEqual({ deltaX: 0, deltaY: 0 });
  });

  it("maps editor crop (normalized-image coords) to source pixels via reference dimensions", () => {
    // Editor shows a 2048x1536 normalized image; the original source is 4096x3072.
    const n = validateAndNormalizeCropRect({ x: 512, y: 384, width: 1024, height: 768, referenceWidth: 2048, referenceHeight: 1536 }, 4096, 3072)!;
    expect(n).toEqual({ x: 1024, y: 768, width: 2048, height: 1536, isFullImage: false });
    const full = validateAndNormalizeCropRect({ x: 0, y: 0, width: 2048, height: 1536, referenceWidth: 2048, referenceHeight: 1536 }, 4096, 3072)!;
    expect(full.isFullImage).toBe(true);
  });

  it("fails closed on invalid / out-of-bounds / non-finite crop rectangles", () => {
    expect(validateAndNormalizeCropRect({ x: -10, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
    expect(validateAndNormalizeCropRect({ x: 0, y: 0, width: 0, height: 10 }, 100, 100)).toBeNull();
    expect(validateAndNormalizeCropRect({ x: 50, y: 0, width: 60, height: 10 }, 100, 100)).toBeNull();
    expect(validateAndNormalizeCropRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
    expect(validateAndNormalizeCropRect({ x: 0, y: 0, width: 10, height: 10, referenceWidth: 0 }, 100, 100)).toBeNull();
  });
});

// ===========================================================================
// 4. Drag / touch / keyboard geometry, reset, extreme aspect ratios
// ===========================================================================
describe("[7][8][9] ドラッグ（タッチ共通）・キーボード・範囲リセット", () => {
  const W = 1000;
  const H = 800;
  const full = createFullCropRect(W, H);

  it("resizes from each corner handle and moves the frame without leaving the image", () => {
    expect(applyDragToCropRect({ startRect: full, handle: "nw", deltaX: 100, deltaY: 50, imageWidth: W, imageHeight: H }))
      .toEqual({ x: 100, y: 50, width: 900, height: 750 });
    expect(applyDragToCropRect({ startRect: full, handle: "se", deltaX: -200, deltaY: -100, imageWidth: W, imageHeight: H }))
      .toEqual({ x: 0, y: 0, width: 800, height: 700 });
    expect(applyDragToCropRect({ startRect: full, handle: "ne", deltaX: -100, deltaY: 100, imageWidth: W, imageHeight: H }))
      .toEqual({ x: 0, y: 100, width: 900, height: 700 });
    expect(applyDragToCropRect({ startRect: full, handle: "sw", deltaX: 100, deltaY: -100, imageWidth: W, imageHeight: H }))
      .toEqual({ x: 100, y: 0, width: 900, height: 700 });
    const small = { x: 100, y: 100, width: 200, height: 200 };
    expect(applyDragToCropRect({ startRect: small, handle: "move", deltaX: 5000, deltaY: -5000, imageWidth: W, imageHeight: H }))
      .toEqual({ x: 800, y: 0, width: 200, height: 200 });
  });

  it("never inverts or collapses the rectangle below the minimum size (free aspect ratio)", () => {
    const r = applyDragToCropRect({ startRect: full, handle: "nw", deltaX: 5000, deltaY: 5000, imageWidth: W, imageHeight: H });
    const { minWidth, minHeight } = getMinCropSize(W, H);
    expect(r.width).toBe(minWidth);
    expect(r.height).toBe(minHeight);
    expect(r.x + r.width).toBe(W);
    expect(r.y + r.height).toBe(H);
    const freeAspect = applyDragToCropRect({ startRect: full, handle: "se", deltaX: -700, deltaY: 0, imageWidth: W, imageHeight: H });
    expect(freeAspect.width / freeAspect.height).not.toBeCloseTo(W / H);
  });

  it("keyboard: arrows step 5%, Shift+arrows step 15%, on handles and on the frame", () => {
    const shrinkRight = applyKeyboardStepToCropRect({ rect: full, handle: "se", key: "ArrowLeft", imageWidth: W, imageHeight: H });
    expect(shrinkRight).toEqual({ x: 0, y: 0, width: 950, height: 800 });
    const shrinkTop = applyKeyboardStepToCropRect({ rect: full, handle: "nw", key: "ArrowDown", shiftKey: true, imageWidth: W, imageHeight: H });
    expect(shrinkTop).toEqual({ x: 0, y: 120, width: 1000, height: 680 });
    const moved = applyKeyboardStepToCropRect({ rect: { x: 100, y: 100, width: 300, height: 300 }, handle: "move", key: "ArrowRight", imageWidth: W, imageHeight: H });
    expect(moved).toEqual({ x: 150, y: 100, width: 300, height: 300 });
    const atEdge = applyKeyboardStepToCropRect({ rect: full, handle: "move", key: "ArrowUp", imageWidth: W, imageHeight: H });
    expect(atEdge).toEqual(full);
  });

  it("reset returns exactly the full-image rectangle", () => {
    const edited = { x: 120, y: 40, width: 300, height: 500 };
    expect(isFullCropRect(edited, W, H)).toBe(false);
    const reset = createFullCropRect(W, H);
    expect(isFullCropRect(reset, W, H)).toBe(true);
    expect(areCropRectsEqual(reset, full)).toBe(true);
    expect(computeCropAreaPercent(reset, W, H)).toBe(100);
  });

  it.each([[8000, 200], [200, 8000], [8192, 1], [1, 8192]])("handles extreme aspect ratio %ix%i safely", (w, h) => {
    const f = createFullCropRect(w, h);
    const { minWidth, minHeight } = getMinCropSize(w, h);
    expect(minWidth).toBeGreaterThanOrEqual(1);
    expect(minWidth).toBeLessThanOrEqual(w);
    expect(minHeight).toBeLessThanOrEqual(h);
    for (const handle of ["nw", "ne", "sw", "se", "move"] as const) {
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) {
        const r = applyKeyboardStepToCropRect({ rect: f, handle, key, shiftKey: true, imageWidth: w, imageHeight: h });
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.width).toBeGreaterThanOrEqual(1);
        expect(r.height).toBeGreaterThanOrEqual(1);
        expect(r.x + r.width).toBeLessThanOrEqual(w);
        expect(r.y + r.height).toBeLessThanOrEqual(h);
      }
    }
    expect(clampCropRect({ x: -5, y: -5, width: 1e9, height: 1e9 }, w, h)).toEqual(f);
  });
});

// ===========================================================================
// 5. processMenuImage with crop — formats, limits, EXIF, orientation, 4 MiB
// ===========================================================================
describe("[2][3][14][15] トリミング送信前処理 — 形式・制限・EXIF除去・4MiB", () => {
  const cases: Array<[string, () => Blob]> = [
    ["image/jpeg", () => jpegBlob(1000, 800, 1)],
    ["image/png", () => pngBlob(1000, 800)],
    ["image/webp", () => webpBlob(1000, 800)],
  ];

  it.each(cases)("crops %s in a single decode + single render pass (no double compression)", async (mime, make) => {
    const { adapter, calls, close } = recordingAdapter({ width: 1000, height: 800 });
    const result = await processMenuImage(make(), {
      adapter,
      crop: { x: 100, y: 200, width: 400, height: 300, referenceWidth: 1000, referenceHeight: 800 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(adapter.decode).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ canvasWidth: 400, canvasHeight: 300, drawWidth: 1000, drawHeight: 800, cropOffsetX: 100, cropOffsetY: 200, mimeType: mime });
    expect(result.value).toMatchObject({ width: 400, height: 300, cropped: true, exifStripped: true, mimeType: mime });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(cases)("strips EXIF/GPS metadata from the cropped %s output", async (_mime, make) => {
    const { adapter } = recordingAdapter({ width: 1000, height: 800 }, [128], "image/jpeg");
    const result = await processMenuImage(make(), { adapter, crop: { x: 10, y: 10, width: 300, height: 300 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = new Uint8Array(await result.value.blob.arrayBuffer());
    expect(hasExifMetadata(out)).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from("GPS"))).toBe(false);
  });

  it("does not mark an all-covering crop as cropped and renders the plain full image", async () => {
    const { adapter, calls } = recordingAdapter({ width: 1000, height: 800 });
    const result = await processMenuImage(pngBlob(1000, 800), { adapter, crop: { x: 0, y: 0, width: 1000, height: 800 } });
    expect(result.ok && result.value.cropped).toBeFalsy();
    expect(calls[0]!.cropOffsetX).toBeUndefined();
    expect(calls[0]).toMatchObject({ canvasWidth: 1000, canvasHeight: 800 });
  });

  it("keeps the existing source limits (20 MiB, 8192 px edge, 16M pixels) when cropping", async () => {
    const { adapter } = recordingAdapter({ width: 1000, height: 800 });
    const crop = { x: 0, y: 0, width: 10, height: 10 };
    const tooBig = new Blob([new Uint8Array(SOURCE_IMAGE_LIMITS.maxBytes + 1)], { type: "image/png" });
    expect(await processMenuImage(tooBig, { adapter, crop })).toEqual({ ok: false, reason: "image_too_large" });
    expect(await processMenuImage(pngBlob(8193, 100), { adapter, crop })).toEqual({ ok: false, reason: "image_too_large" });
    expect(await processMenuImage(pngBlob(5000, 4000), { adapter, crop })).toEqual({ ok: false, reason: "image_too_large" });
    expect(await processMenuImage(new Blob([new Uint8Array([1, 2, 3])], { type: "image/gif" }), { adapter, crop }))
      .toEqual({ ok: false, reason: "unsupported_image_type" });
    expect(adapter.decode).not.toHaveBeenCalled();
  });

  it("rejects an invalid crop with the existing INVALID_INPUT reason (malformed_request)", async () => {
    const { adapter, calls } = recordingAdapter({ width: 1000, height: 800 });
    const result = await processMenuImage(pngBlob(1000, 800), { adapter, crop: { x: 900, y: 0, width: 400, height: 100 } });
    expect(result).toEqual({ ok: false, reason: "malformed_request" });
    expect(calls).toHaveLength(0);
  });

  it("steps down quality/edge so the cropped payload is <= 4 MiB, or fails with image_too_large", async () => {
    const huge = IMAGE_CONSTRAINTS.maxBytes + 1024;
    const { adapter, calls } = recordingAdapter({ width: 6000, height: 2000 }, [huge, huge, huge, 200_000]);
    const result = await processMenuImage(pngBlob(6000, 2000), { adapter, crop: { x: 0, y: 0, width: 4000, height: 1000 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processedBytes).toBeLessThanOrEqual(IMAGE_CONSTRAINTS.maxBytes);
    expect(result.value.cropped).toBe(true);
    // 4th attempt uses the 1600px edge step; crop aspect (4:1) is preserved.
    expect(calls[3]).toMatchObject({ canvasWidth: 1600, canvasHeight: 400 });
    for (const c of calls) expect(Math.max(c.canvasWidth, c.canvasHeight)).toBeLessThanOrEqual(2048);

    const never = recordingAdapter({ width: 6000, height: 2000 }, [huge]);
    expect(await processMenuImage(pngBlob(6000, 2000), { adapter: never.adapter, crop: { x: 0, y: 0, width: 4000, height: 1000 } }))
      .toEqual({ ok: false, reason: "image_too_large" });
  });

  it.each([[8000, 200], [200, 8000]])("crops extreme aspect ratio sources (%ix%i)", async (w, h) => {
    const { adapter, calls } = recordingAdapter({ width: w, height: h });
    const crop = w > h ? { x: 2000, y: 0, width: 4000, height: 200 } : { x: 0, y: 2000, width: 200, height: 4000 };
    const result = await processMenuImage(pngBlob(w, h), { adapter, crop });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = calls[0]!;
    expect(Math.max(c.canvasWidth, c.canvasHeight)).toBe(2048);
    expect(Math.min(c.canvasWidth, c.canvasHeight)).toBe(102);
    expect(c.canvasWidth + (c.cropOffsetX ?? 0)).toBeLessThanOrEqual(w > h ? 4096 : 102);
  });
});

describe("[5] 回転情報（EXIF Orientation 1..8）とトリミングの整合", () => {
  const orientations: ExifOrientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

  it.each(orientations)("orientation %i: crop is taken from the UPRIGHT image in the same canvas pass", async (o) => {
    // Stored (raw) pixels are 400x300; upright is 300x400 for 5..8.
    const rawW = 400;
    const rawH = 300;
    const swap = doesOrientationSwapDimensions(o);
    const upW = swap ? rawH : rawW;
    const upH = swap ? rawW : rawH;
    const crop = { x: Math.round(upW * 0.25), y: Math.round(upH * 0.5), width: Math.round(upW * 0.5), height: Math.round(upH * 0.25) };

    const { adapter, calls } = recordingAdapter({ width: rawW, height: rawH, orientationAlreadyApplied: false });
    const result = await processMenuImage(jpegBlob(rawW, rawH, o), { adapter, crop });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detectedOrientation).toBe(o);
    const c = calls[0]!;
    expect(c.orientationToApply).toBe(o);
    expect({ w: c.canvasWidth, h: c.canvasHeight }).toEqual({ w: crop.width, h: crop.height });

    // Replay the exact transform order used by browserCanvasAdapter and verify where raw pixels land.
    const { ctx, apply } = trackingCtx();
    ctx.translate(-(c.cropOffsetX ?? 0), -(c.cropOffsetY ?? 0));
    applyExifOrientationTransform(ctx, c.drawWidth, c.drawHeight, o);
    for (const [x, y] of [[0, 0], [rawW, 0], [0, rawH], [rawW, rawH], [123, 77]] as const) {
      const up = exifUpright(o, x, y, rawW, rawH);
      expect(apply(x, y)).toEqual({ x: up.x - crop.x, y: up.y - crop.y });
    }
  });

  it("does not rotate twice when the decoder already applied orientation", async () => {
    const { adapter, calls } = recordingAdapter({ width: 300, height: 400, orientationAlreadyApplied: true });
    const result = await processMenuImage(jpegBlob(400, 300, 6), { adapter, crop: { x: 0, y: 0, width: 150, height: 200 } });
    expect(result.ok).toBe(true);
    expect(calls[0]!.orientationToApply).toBe(1);
    expect(calls[0]).toMatchObject({ canvasWidth: 150, canvasHeight: 200, drawWidth: 300, drawHeight: 400 });
  });

  it("browserCanvasAdapter guarantees orientationAlreadyApplied: true on createImageBitmap to prevent double rotation (audit MINOR guarantee)", async () => {
    const holder = globalThis as unknown as { createImageBitmap?: unknown };
    const origCreateImageBitmap = holder.createImageBitmap;
    try {
      holder.createImageBitmap = vi.fn(async () => ({
        width: 100,
        height: 160,
        close: vi.fn(),
      }));
      const dummyBlob = new Blob([new Uint8Array(64)], { type: "image/jpeg" });
      const decoded = await browserCanvasAdapter.decode(dummyBlob, new Uint8Array(64));
      expect(decoded.orientationAlreadyApplied).toBe(true);
      expect(decoded.width).toBe(100);
      expect(decoded.height).toBe(160);
    } finally {
      holder.createImageBitmap = origCreateImageBitmap;
    }
  });

  it("computeOrientedCropDimensions clamps offsets inside the drawn upright image", () => {
    const d = computeOrientedCropDimensions(400, 300, 2048, 6, { x: 250, y: 350, width: 50, height: 50, isFullImage: false });
    expect(d.canvasWidth).toBe(50);
    expect(d.cropOffsetX + d.canvasWidth).toBeLessThanOrEqual(300);
    expect(d.cropOffsetY + d.canvasHeight).toBeLessThanOrEqual(400);
  });
});

describe("[16] 画像処理失敗時の復旧", () => {
  it("decode failure / render failure fail closed and release the decoded source", async () => {
    const failingDecode: ImageTranscodeAdapter = {
      decode: vi.fn(async () => { throw new Error("synthetic decode failure"); }),
      renderToBlob: vi.fn(),
    };
    expect(await processMenuImage(pngBlob(100, 100), { adapter: failingDecode, crop: { x: 0, y: 0, width: 50, height: 50 } }))
      .toEqual({ ok: false, reason: "unsupported_image_type" });

    const close = vi.fn();
    const failingRender: ImageTranscodeAdapter = {
      decode: vi.fn(async () => ({ width: 100, height: 100, orientationAlreadyApplied: true, source: {}, close })),
      renderToBlob: vi.fn(async () => { throw new Error("synthetic canvas failure"); }),
    };
    expect(await processMenuImage(pngBlob(100, 100), { adapter: failingRender, crop: { x: 0, y: 0, width: 50, height: 50 } }))
      .toEqual({ ok: false, reason: "malformed_request" });
    expect(close).toHaveBeenCalledTimes(1);

    // A subsequent valid request still succeeds (no sticky failure state in the processor).
    const { adapter } = recordingAdapter({ width: 100, height: 100 });
    expect((await processMenuImage(pngBlob(100, 100), { adapter, crop: { x: 0, y: 0, width: 50, height: 50 } })).ok).toBe(true);
  });
});
