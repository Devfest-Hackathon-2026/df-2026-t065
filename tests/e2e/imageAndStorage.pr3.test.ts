import { describe, expect, it, vi } from "vitest";
import { ALLERGEN_CODES, type AllergenCode } from "@/contracts/allergens";
import { IMAGE_CONSTRAINTS } from "@/contracts/analyze";
import {
  MOCK_SCENARIO_HEADER_NAME,
  buildAnalyzeMenuFormData,
  isDevMockPanelAllowed,
  submitAnalyzeMenu,
} from "@/client/analyzeClient";
import {
  applyExifOrientationTransform,
  computeOrientedDimensions,
  doesOrientationSwapDimensions,
  hasExifMetadata,
  processMenuImage,
  readJpegExifOrientation,
  sniffImageMimeType,
  stripExifMetadataBytes,
  type CanvasContext2DLike,
  type ExifOrientation,
  type ImageTranscodeAdapter,
} from "@/client/imageProcessor";
import {
   groupAssessmentsByCategory,
  organizeResultsByAllergen,
  splitTextByExcerpts,
} from "@/client/resultOrganizer";
import {
  SETTINGS_STORAGE_KEY,
  clearUserSettings,
  loadUserSettings,
  normalizeSelectedAllergens,
   sanitizeUserSettings,
  saveUserSettings,
  type StorageLike,
} from "@/client/settingsStorage";
import { handleAnalyzeMenu } from "@/server/analyzeMenu";
import { MOCK_FIXTURES } from "@/server/mockFixtures";

function createMemoryStorage(): StorageLike & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

/**
 * Builds a minimal valid JPEG byte stream of exact `size` bytes (SOI 0xFFD8 + SOS 0xFFDA + payload + EOI 0xFFD9)
 * without EXIF metadata, satisfying both client and server magic-byte checks (0xFF 0xD8 0xFF).
 */
function createCleanJpegBytes(size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(8, size));
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xda;
  b[b.length - 2] = 0xff;
  b[b.length - 1] = 0xd9;
  return b;
}

/**
 * Builds a synthetic minimal JPEG byte array containing an APP1 Exif segment with the given Orientation (1..8)
 * and dummy GPS/camera bytes, followed by SOS and EOI markers.
 */
function createSyntheticJpegWithExif(orientation: number, extraPayloadBytes = 64): Uint8Array {
  // Minimal Exif APP1 payload:
  // "Exif\0\0" (6 bytes)
  // TIFF header (big-endian "MM", 0x002A, IFD0 offset = 8) (8 bytes)
  // IFD0 entry count = 1 (2 bytes)
  // Tag 0x0112 (Orientation), Type 3 (SHORT), Count 1, Value (orientation << 16) (12 bytes)
  // Next IFD offset = 0 (4 bytes)
  const exifPayloadLen = 6 + 8 + 2 + 12 + 4;
  const app1Length = 2 + exifPayloadLen; // includes 2-byte length field
  const totalLength = 2 + 2 + app1Length + 10 + 2 + extraPayloadBytes + 2;
  const buf = new Uint8Array(totalLength);
  const view = new DataView(buf.buffer);

  let pos = 0;
  // SOI
  buf[pos++] = 0xff;
  buf[pos++] = 0xd8;
  // APP1 marker
  buf[pos++] = 0xff;
  buf[pos++] = 0xe1;
  view.setUint16(pos, app1Length, false);
  pos += 2;
  // "Exif\0\0"
  buf.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], pos);
  pos += 6;
  // Big-endian TIFF header "MM"
  buf[pos++] = 0x4d;
  buf[pos++] = 0x4d;
  view.setUint16(pos, 0x002a, false);
  pos += 2;
  view.setUint32(pos, 8, false);
  pos += 4;
  // IFD0: 1 entry
  view.setUint16(pos, 1, false);
  pos += 2;
  // Entry: Tag 0x0112 (Orientation), Type 3 (SHORT), Count 1
  view.setUint16(pos, 0x0112, false);
  pos += 2;
  view.setUint16(pos, 3, false);
  pos += 2;
  view.setUint32(pos, 1, false);
  pos += 4;
  view.setUint16(pos, orientation, false);
  pos += 2;
  view.setUint16(pos, 0, false);
  pos += 2;
  // Next IFD = 0
  view.setUint32(pos, 0, false);
  pos += 4;

  // SOF dimensions for the pre-decode resource check (synthetic test header).
  buf.set([0xff, 0xc0, 0, 8, 8, 0x0b, 0xd0, 0x0f, 0xc0, 0], pos);
  pos += 10;
  // SOS (0xFFDA) + scan payload + EOI (0xFFD9)
  buf[pos++] = 0xff;
  buf[pos++] = 0xda;
  for (let i = 0; i < extraPayloadBytes; i++) {
    buf[pos++] = (i * 17) & 0xff;
  }
  buf[pos++] = 0xff;
  buf[pos++] = 0xd9;
  return buf;
}

/**
 * Builds a synthetic PNG with an eXIf chunk.
 */
function createSyntheticPngWithExif(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  // Chunk 1: IHDR (length 4 dummy)
  const ihdr = [0x00, 0x00, 0x00, 0x04, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 0, 0, 0, 0];
  // Chunk 2: eXIf (length 4 dummy)
  const exif = [0x00, 0x00, 0x00, 0x04, 0x65, 0x58, 0x49, 0x66, 9, 9, 9, 9, 0, 0, 0, 0];
  // Chunk 3: IEND (length 0)
  const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0];
  return new Uint8Array([...sig, ...ihdr, ...exif, ...iend]);
}

/**
 * Builds a synthetic WebP with an EXIF chunk.
 */
function createSyntheticWebpWithExif(): Uint8Array {
  // RIFF header (12 bytes) + VP8X chunk (12 bytes) + EXIF chunk (12 bytes)
  const buf = new Uint8Array(36);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 28, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  // Chunk 1: "VP8 " (size 4)
  buf.set([0x56, 0x50, 0x38, 0x20], 12);
  view.setUint32(16, 4, true);
  buf.set([1, 2, 3, 4], 20);
  // Chunk 2: "EXIF" (size 4)
  buf.set([0x45, 0x58, 0x49, 0x46], 24);
  view.setUint32(28, 4, true);
  buf.set([5, 6, 7, 8], 32);
  return buf;
}

describe("settingsStorage (browser-only persistence & validation)", () => {
  it("persists and loads valid language pairs and deduplicated canonical allergens", () => {
    const storage = createMemoryStorage();
    const saved = saveUserSettings(
      {
        userLang: "en",
        storeLang: "ja",
        allergens: ["fish", "shrimp", "fish", "egg"],
      },
      storage,
    );
    expect(saved).toEqual({
      userLang: "en",
      storeLang: "ja",
      allergens: ["shrimp", "egg", "fish"],
    });
    expect(storage.dump()[SETTINGS_STORAGE_KEY]).toBeDefined();

    const loaded = loadUserSettings(storage);
    expect(loaded).toEqual(saved);
  });

  it("supports all 11 MVP allergens and rejects unknown codes or unsupported language pairs", () => {
    const allSelected = normalizeSelectedAllergens([...ALLERGEN_CODES]);
    expect(allSelected).toHaveLength(11);

    // Unsupported language pair (e.g. ja -> fr) falls back to ja -> en while keeping valid allergens
    const fallbackLang = sanitizeUserSettings({
      userLang: "ja",
      storeLang: "fr",
      allergens: ["peanut", "walnut"],
    });
    expect(fallbackLang).toEqual({
      userLang: "ja",
      storeLang: "en",
      allergens: ["walnut", "peanut"],
    });

    // Unknown allergen code in corrupted storage is safely reset
    const corrupted = sanitizeUserSettings({
      userLang: "ja",
      storeLang: "en",
      allergens: ["almond" as AllergenCode],
    });
    expect(corrupted.allergens).toEqual([]);
  });

  it("clears stored settings from browser storage", () => {
    const storage = createMemoryStorage();
    saveUserSettings({ userLang: "ja", storeLang: "en", allergens: ["milk"] }, storage);
    expect(loadUserSettings(storage).allergens).toEqual(["milk"]);

    const afterClear = clearUserSettings(storage);
    expect(afterClear.allergens).toEqual([]);
    expect(storage.dump()[SETTINGS_STORAGE_KEY]).toBeUndefined();
    expect(loadUserSettings(storage).allergens).toEqual([]);
  });
});

describe("imageProcessor (format, 4MiB size limit, EXIF removal, orientation handling)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)(
    "reads EXIF Orientation %i from JPEG APP1 header and strips EXIF completely",
    (orientation) => {
      const jpegWithExif = createSyntheticJpegWithExif(orientation);
      expect(hasExifMetadata(jpegWithExif)).toBe(true);
      expect(readJpegExifOrientation(jpegWithExif)).toBe(orientation);

      const stripped = stripExifMetadataBytes(jpegWithExif);
      expect(hasExifMetadata(stripped)).toBe(false);
      expect(readJpegExifOrientation(stripped)).toBe(1);
      // Preserves SOI (0xFFD8) and EOI (0xFFD9)
      expect(stripped[0]).toBe(0xff);
      expect(stripped[1]).toBe(0xd8);
      expect(stripped[stripped.length - 2]).toBe(0xff);
      expect(stripped[stripped.length - 1]).toBe(0xd9);
    },
  );

  it("detects and strips EXIF chunks from PNG and WebP", () => {
    const pngWithExif = createSyntheticPngWithExif();
    expect(hasExifMetadata(pngWithExif)).toBe(true);
    const cleanPng = stripExifMetadataBytes(pngWithExif);
    expect(hasExifMetadata(cleanPng)).toBe(false);

    const webpWithExif = createSyntheticWebpWithExif();
    expect(hasExifMetadata(webpWithExif)).toBe(true);
    const cleanWebp = stripExifMetadataBytes(webpWithExif);
    expect(hasExifMetadata(cleanWebp)).toBe(false);
  });

  it("computes oriented canvas dimensions and swaps width/height for EXIF orientations 5..8", () => {
    // 4000x3000 portrait photo stored with EXIF orientation 6 (90° CW)
    expect(doesOrientationSwapDimensions(1)).toBe(false);
    expect(doesOrientationSwapDimensions(6)).toBe(true);
    expect(doesOrientationSwapDimensions(8)).toBe(true);

    const dims = computeOrientedDimensions(4000, 3000, 2048, 6);
    expect(dims.drawWidth).toBe(2048);
    expect(dims.drawHeight).toBe(1536);
    // Upright canvas dimensions are swapped to 1536 x 2048 (portrait)
    expect(dims.canvasWidth).toBe(1536);
    expect(dims.canvasHeight).toBe(2048);
  });

  it("applies the expected 2D canvas transforms for EXIF orientations 1..8", () => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as ExifOrientation[]) {
      const ops: string[] = [];
      const mockCtx: CanvasContext2DLike = {
        save: () => ops.push("save"),
        restore: () => ops.push("restore"),
        translate: (x, y) => ops.push(`translate(${x},${y})`),
        rotate: (a) => ops.push(`rotate(${a.toFixed(2)})`),
        scale: (x, y) => ops.push(`scale(${x},${y})`),
        drawImage: () => ops.push("drawImage"),
      };
      applyExifOrientationTransform(mockCtx, 200, 100, orientation);
      if (orientation === 1) {
        expect(ops).toEqual([]);
      } else {
        expect(ops.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects missing, empty, disguised, or unsupported image MIME types", async () => {
    expect(await processMenuImage(null)).toEqual({ ok: false, reason: "image_missing" });
    expect(await processMenuImage(new Blob([], { type: "image/jpeg" }))).toEqual({
      ok: false,
      reason: "image_missing",
    });
    expect(await processMenuImage(new Blob(["gif89a"], { type: "image/gif" }))).toEqual({
      ok: false,
      reason: "unsupported_image_type",
    });
    // Disguised file: declared image/jpeg but bytes are all zeros (not 0xFF 0xD8 0xFF)
    expect(await processMenuImage(new Blob([new Uint8Array(32)], { type: "image/jpeg" }))).toEqual({
      ok: false,
      reason: "unsupported_image_type",
    });
    expect(sniffImageMimeType(createCleanJpegBytes(32))).toBe("image/jpeg");
    expect(sniffImageMimeType(createSyntheticPngWithExif())).toBe("image/png");
    expect(sniffImageMimeType(createSyntheticWebpWithExif())).toBe("image/webp");
    expect(sniffImageMimeType(new Uint8Array(16))).toBeNull();
  });

  it("re-encodes JPEG/PNG/WebP via adapter, normalizes EXIF orientation, strips EXIF, and enforces <= 4 MiB", async () => {
    const rawJpeg = createSyntheticJpegWithExif(6, 500);
    const inputBlob = new Blob([rawJpeg.buffer as ArrayBuffer], { type: "image/jpeg" });

    let recordedOrientation: ExifOrientation | null = null;
    const mockAdapter: ImageTranscodeAdapter = {
      async decode() {
        return {
          width: 4032,
          height: 3024,
          orientationAlreadyApplied: false,
          source: {},
        };
      },
      async renderToBlob({ orientationToApply, mimeType }) {
        recordedOrientation = orientationToApply;
        // Even if the underlying encoder left an Exif segment, processMenuImage strips it
        const bytes = createSyntheticJpegWithExif(6, 128);
        return new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
      },
    };

    const result = await processMenuImage(inputBlob, { adapter: mockAdapter });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(recordedOrientation).toBe(6);
    expect(result.value.detectedOrientation).toBe(6);
    // Swapped to upright portrait dimensions (1536 x 2048)
    expect(result.value.width).toBe(1536);
    expect(result.value.height).toBe(2048);
    expect(result.value.exifStripped).toBe(true);
    expect(result.value.processedBytes).toBeLessThanOrEqual(IMAGE_CONSTRAINTS.maxBytes);

    const outputBytes = new Uint8Array(await result.value.blob.arrayBuffer());
    expect(hasExifMetadata(outputBytes)).toBe(false);
  });

  it("steps down quality/dimensions when initial render exceeds 4 MiB, and fails with image_too_large if impossible", async () => {
    const inputBlob = new Blob([createSyntheticJpegWithExif(1, 64).buffer as ArrayBuffer], { type: "image/jpeg" });
    let callCount = 0;

    const steppingAdapter: ImageTranscodeAdapter = {
      async decode() {
        return { width: 3000, height: 2000, orientationAlreadyApplied: true, source: {} };
      },
      async renderToBlob({ quality, mimeType }) {
        callCount++;
        // First quality attempt (0.88) returns > 4 MiB; second attempt (0.82) fits under 4 MiB
        const byteLen = quality > 0.85 ? IMAGE_CONSTRAINTS.maxBytes + 1024 : 100 * 1024;
        return new Blob([createCleanJpegBytes(byteLen).buffer as ArrayBuffer], { type: mimeType });
      },
    };

    const steppedResult = await processMenuImage(inputBlob, { adapter: steppingAdapter });
    expect(steppedResult.ok).toBe(true);
    expect(callCount).toBe(2);

    const alwaysHugeAdapter: ImageTranscodeAdapter = {
      async decode() {
        return { width: 3000, height: 2000, orientationAlreadyApplied: true, source: {} };
      },
      async renderToBlob({ mimeType }) {
        return new Blob([createCleanJpegBytes(IMAGE_CONSTRAINTS.maxBytes + 10).buffer as ArrayBuffer], {
          type: mimeType,
        });
      },
    };
    const hugeResult = await processMenuImage(inputBlob, { adapter: alwaysHugeAdapter });
    expect(hugeResult).toEqual({ ok: false, reason: "image_too_large" });
  });
});

describe("analyzeClient & production mock safety", () => {
  const sampleImage = new Blob([createCleanJpegBytes(64).buffer as ArrayBuffer], { type: "image/jpeg" });

  it("builds valid FormData and integrates with handleAnalyzeMenu in mock mode", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const req = new Request("http://localhost/api/analyze-menu", {
        method: init?.method ?? "POST",
        body: init?.body as BodyInit,
        headers: init?.headers,
      });
      return handleAnalyzeMenu(req, { NODE_ENV: "development", MOCK_GEMINI: "true" });
    };

    const res = await submitAnalyzeMenu({
      userLang: "ja",
      storeLang: "en",
      allergens: ["shrimp", "peanut"],
      image: sampleImage,
      mockScenario: "negation_claims",
      nodeEnv: "development",
      fetchImpl: fetchMock,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.dataOrigin).toBe("mock_fixture");
    expect(res.data.items.length).toBeGreaterThan(0);
  });

  it("never sends x-mock-scenario header in production and rejects mock_fixture responses in production", async () => {
    expect(isDevMockPanelAllowed("development")).toBe(true);
    expect(isDevMockPanelAllowed("test")).toBe(true);
    expect(isDevMockPanelAllowed("production")).toBe(false);

    let capturedHeaders: Headers | null = null;
    const prodFetchMock: typeof fetch = async (_input, init) => {
      const req = new Request("http://localhost/api/analyze-menu", {
        method: "POST",
        body: init?.body as BodyInit,
        headers: init?.headers,
      });
      capturedHeaders = req.headers;
      // Even if a misconfigured server ever returned mock_fixture in production, client blocks it
      return Response.json(MOCK_FIXTURES.ok.body, { status: 200 });
    };

    const res = await submitAnalyzeMenu({
      userLang: "ja",
      storeLang: "en",
      allergens: ["shrimp", "wheat", "egg", "milk"],
      image: sampleImage,
      mockScenario: "ok",
      nodeEnv: "production",
      fetchImpl: prodFetchMock,
    });

    expect(capturedHeaders!.get(MOCK_SCENARIO_HEADER_NAME)).toBeNull();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.error.code).toBe("AI_FAILED");
  });

  it("pre-validates FormData before network call and returns INVALID_INPUT on empty allergens", async () => {
    const form = buildAnalyzeMenuFormData({
      userLang: "ja",
      storeLang: "en",
      allergens: ["shrimp"],
      image: sampleImage,
    });
    expect([...form.keys()].sort()).toEqual(["allergens", "image", "storeLang", "userLang"]);

    const badRes = await submitAnalyzeMenu({
      userLang: "ja",
      storeLang: "en",
      allergens: [],
      image: sampleImage,
    });
    expect(badRes).toEqual({
      ok: false,
      error: {
        requestId: "client-precheck",
        error: { code: "INVALID_INPUT", retryable: false, reason: "invalid_allergens" },
      },
    });
  });

  it.each([201, 202, 204, 206])(
    "rejects non-200 2xx status code %i as AI_FAILED (MINOR-1)",
    async (statusCode) => {
      const fetchNon200: typeof fetch = async () => {
        if (statusCode === 204) {
          return new Response(null, { status: 204 });
        }
        return Response.json(MOCK_FIXTURES.ok.body, { status: statusCode });
      };

      const res = await submitAnalyzeMenu({
        userLang: "ja",
        storeLang: "en",
        allergens: ["shrimp", "wheat", "egg", "milk"],
        image: sampleImage,
        nodeEnv: "development",
        fetchImpl: fetchNon200,
      });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected failure");
      expect(res.error.error.code).toBe("AI_FAILED");
    },
  );

  it("propagates caller AbortSignal and never treats aborted requests as success (BLOCKER / MINOR-2)", async () => {
    const controller = new AbortController();
    const slowFetch: typeof fetch = async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    };

    const pending = submitAnalyzeMenu({
      userLang: "ja",
      storeLang: "en",
      allergens: ["shrimp"],
      image: sampleImage,
      signal: controller.signal,
      fetchImpl: slowFetch,
    });
    controller.abort();
    const res = await pending;

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected aborted failure");
    expect(res.aborted).toBe(true);
    expect(res.error.error.code).toBe("AI_FAILED");
  });

  it("enforces client timeoutMs deadline and returns AI_TIMEOUT without retrying (MINOR-2)", async () => {
    let calls = 0;
    const stalledFetch: typeof fetch = async (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Timed out", "AbortError"));
        });
      });
    };

    const res = await submitAnalyzeMenu({
      userLang: "ja",
      storeLang: "en",
      allergens: ["shrimp"],
      image: sampleImage,
      timeoutMs: 40,
      fetchImpl: stalledFetch,
    });

    expect(calls).toBe(1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected timeout");
    expect(res.aborted).toBeUndefined();
    expect(res.error.error.code).toBe("AI_TIMEOUT");
  });

  it.each(["fetch", "json"])("rejects success after synchronous %s blocks the event loop before the timer fires", async (stage) => {
    let timerFired = false;
    const marker = setTimeout(() => { timerFired = true; }, 0);
    const block = () => {
      const until = performance.now() + 30;
      while (performance.now() < until) { /* reproduce a busy event loop */ }
    };
    const fetchImpl: typeof fetch = async () => {
      if (stage === "fetch") block();
      const response = Response.json(MOCK_FIXTURES.ok.body);
      if (stage === "json") response.json = async () => { block(); return MOCK_FIXTURES.ok.body; };
      return response;
    };
    try {
      const result = await submitAnalyzeMenu({ userLang: "ja", storeLang: "en",
        allergens: ["shrimp", "wheat", "egg", "milk"], image: sampleImage, timeoutMs: 1, fetchImpl });
      expect(timerFired).toBe(false);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("late success accepted");
      expect(result.error.error.code).toBe("AI_TIMEOUT");
    } finally { clearTimeout(marker); }
  });

  it.each(["fetch", "json"])("times out a never-settling %s promise that ignores AbortSignal", async (stage) => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (stage === "fetch") return new Promise<Response>(() => {});
      const response = Response.json(MOCK_FIXTURES.ok.body);
      response.json = () => new Promise(() => {});
      return response;
    };
    const result = await submitAnalyzeMenu({ userLang: "ja", storeLang: "en", allergens: ["shrimp"],
      image: sampleImage, timeoutMs: 10, fetchImpl });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout");
    expect(result.error.error.code).toBe("AI_TIMEOUT");
  });

  it("rejects at the exact monotonic deadline after schema validation", async () => {
    // Advance the production clock during schema access; no test-only success path.
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const body = structuredClone(MOCK_FIXTURES.ok.body);
    Object.defineProperty(body, "requestId", { get() { now = 110; return "deadline-schema"; } });
    try {
      const response = Response.json({});
      response.json = async () => body;
      const result = await submitAnalyzeMenu({ userLang: "ja", storeLang: "en",
        allergens: ["shrimp", "wheat", "egg", "milk"], image: sampleImage, timeoutMs: 10,
        fetchImpl: async () => response });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected timeout");
      expect(result.error.error.code).toBe("AI_TIMEOUT");
    } finally { clock.mockRestore(); }
  });

  it.each([[429, "RATE_LIMITED"], [503, "AI_DISABLED"], [504, "AI_TIMEOUT"]] as const)(
    "preserves HTTP %i errors before the deadline", async (status, code) => {
      const result = await submitAnalyzeMenu({ userLang: "ja", storeLang: "en", allergens: ["shrimp"],
        image: sampleImage, fetchImpl: async () => Response.json({ requestId: "http-error",
          error: { code, retryable: code !== "AI_DISABLED" } }, { status }) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.error.code).toBe(code);
    });

});

describe("resultOrganizer (dish & allergen grouping + plain-text excerpt splitting)", () => {
  it("groups dish assessments into the 3 categories and organizes by selected allergens", () => {
    const okData = MOCK_FIXTURES.ok.body;
    const firstDishGrouped = groupAssessmentsByCategory(okData.items[0]!.allergens as never);
    expect(firstDishGrouped.menu_mentions.map((a) => a.code)).toEqual(["shrimp"]);
    expect(firstDishGrouped.ai_inferred.map((a) => a.code)).toEqual(["wheat", "egg"]);
    expect(firstDishGrouped.unconfirmed.map((a) => a.code)).toEqual(["milk"]);

    const byAllergen = organizeResultsByAllergen(okData as never, ["shrimp", "milk"]);
    expect(byAllergen).toHaveLength(2);
    expect(byAllergen[0]!.code).toBe("shrimp");
    expect(byAllergen[0]!.menu_mentions).toHaveLength(1);
    expect(byAllergen[0]!.unconfirmed).toHaveLength(2);
  });

  it("splits readText by excerpt for safe plain-text highlighting without HTML injection", () => {
    const segments = splitTextByExcerpts("Chocolate Brownie (peanut-free)", ["peanut-free"]);
    expect(segments).toEqual([
      { text: "Chocolate Brownie (", highlighted: false },
      { text: "peanut-free", highlighted: true },
      { text: ")", highlighted: false },
    ]);
  });
});
