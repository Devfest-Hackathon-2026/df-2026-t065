/*
 * _notice: SYNTHETIC TEST DATA — programmatically generated JPEGs with real EXIF Orientation 1..8 metadata.
 * Real browser regression test via headless Chrome/Edge CDP.
 * No real menu photos or personal data are used.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hasExifMetadata,
  processMenuImage,
  readJpegExifOrientation,
  type ImageTranscodeAdapter,
} from "@/client/imageProcessor";
import { launchBrowser, type BrowserInstance, type PageInstance } from "./browser/cdp.mjs";
import {
  assertCropBoundaryPixels,
  EXPECTED_CROP_HEIGHT,
  EXPECTED_CROP_WIDTH,
  EXPECTED_CROP_X,
  EXPECTED_CROP_Y,
  EXPECTED_UPRIGHT_HEIGHT,
  EXPECTED_UPRIGHT_WIDTH,
  generateSyntheticExifJpegs,
  isBlue,
  isGreen,
  isRed,
  isYellow,
  ORIENTATION_CONFIGS,
  type CropSamplePixels,
} from "./browser/syntheticExifJpeg.mjs";

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

const hasBrowser = BROWSER_CANDIDATES.some((p) => existsSync(p));

describe.runIf(hasBrowser)("EXIF real browser regression test (Orientation 1..8)", () => {
  let browser: BrowserInstance;
  let page: PageInstance;
  let jpegBuffers: Record<number, Buffer>;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto("about:blank");
    jpegBuffers = await generateSyntheticExifJpegs(page);
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  for (let orientation = 1; orientation <= 8; orientation++) {
    const cfg = ORIENTATION_CONFIGS[orientation as keyof typeof ORIENTATION_CONFIGS];

    it(`Orientation ${orientation} (${cfg?.name ?? orientation}): verifies decoding, dimensions, pixel colors, no double-rotation, crop and EXIF strip`, async () => {
      const buffer = jpegBuffers[orientation];
      expect(buffer).toBeDefined();
      if (!buffer) throw new Error(`Missing buffer for orientation ${orientation}`);

      // Verify that input is a valid JPEG with detected EXIF orientation
      const rawBytes = new Uint8Array(buffer);
      expect(readJpegExifOrientation(rawBytes)).toBe(orientation);
      expect(hasExifMetadata(rawBytes)).toBe(true);

      // Transcode adapter backed by real browser Canvas & ImageBitmap
      const adapter: ImageTranscodeAdapter = {
        decode: async (blob) => {
          const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
          const decoded = await page.eval<{ width: number; height: number; orientationAlreadyApplied: boolean }>(`(async () => {
            const bin = atob(${JSON.stringify(b64)});
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const b = new Blob([arr], { type: "image/jpeg" });
            const bmp = await createImageBitmap(b);
            window.__currentBitmap = bmp;
            return {
              width: bmp.width,
              height: bmp.height,
              orientationAlreadyApplied: true, // browserCanvasAdapter contract
            };
          })()`);
          return {
            width: decoded.width,
            height: decoded.height,
            orientationAlreadyApplied: decoded.orientationAlreadyApplied,
            source: {},
            close: () => {
              page.eval(`window.__currentBitmap?.close?.()`).catch(() => {});
            },
          };
        },
        renderToBlob: async ({
          canvasWidth,
          canvasHeight,
          drawWidth,
          drawHeight,
          orientationToApply,
          cropOffsetX,
          cropOffsetY,
          quality,
          mimeType,
        }) => {
          const outB64 = await page.eval<string>(`(async () => {
            const bmp = window.__currentBitmap;
            const canvas = document.createElement("canvas");
            canvas.width = ${canvasWidth};
            canvas.height = ${canvasHeight};
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("2D context unavailable");

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.save();
            ${cropOffsetX || cropOffsetY ? `ctx.translate(-${cropOffsetX ?? 0}, -${cropOffsetY ?? 0});` : ""}

            // applyExifOrientationTransform
            const o = ${orientationToApply};
            switch (o) {
              case 2:
                ctx.translate(${drawWidth}, 0);
                ctx.scale(-1, 1);
                break;
              case 3:
                ctx.translate(${drawWidth}, ${drawHeight});
                ctx.rotate(Math.PI);
                break;
              case 4:
                ctx.translate(0, ${drawHeight});
                ctx.scale(1, -1);
                break;
              case 5:
                ctx.rotate(0.5 * Math.PI);
                ctx.scale(1, -1);
                break;
              case 6:
                ctx.translate(${drawHeight}, 0);
                ctx.rotate(0.5 * Math.PI);
                break;
              case 7:
                ctx.translate(${drawHeight}, ${drawWidth});
                ctx.rotate(0.5 * Math.PI);
                ctx.scale(-1, 1);
                break;
              case 8:
                ctx.translate(0, ${drawWidth});
                ctx.rotate(-0.5 * Math.PI);
                break;
              case 1:
              default:
                break;
            }

            ctx.drawImage(bmp, 0, 0, ${drawWidth}, ${drawHeight});
            ctx.restore();

            const outBlob = await new Promise((res) => canvas.toBlob(res, ${JSON.stringify(mimeType)}, ${quality}));
            const outBuf = new Uint8Array(await outBlob.arrayBuffer());
            let binary = "";
            for (let i = 0; i < outBuf.length; i++) binary += String.fromCharCode(outBuf[i]);
            return btoa(binary);
          })()`);
          return new Blob([new Uint8Array(Buffer.from(outB64, "base64"))], { type: mimeType });
        },
      };

      const inputFile = new File([new Uint8Array(buffer)], `test-orientation-${orientation}.jpg`, { type: "image/jpeg" });

      // 1. Uncropped processing through processMenuImage
      const uncroppedResult = await processMenuImage(inputFile, { adapter });
      expect(uncroppedResult.ok).toBe(true);
      if (!uncroppedResult.ok) return;

      const uncropped = uncroppedResult.value;
      expect(uncropped.width).toBe(EXPECTED_UPRIGHT_WIDTH);
      expect(uncropped.height).toBe(EXPECTED_UPRIGHT_HEIGHT);
      expect(uncropped.detectedOrientation).toBe(orientation);

      // Orientation 6 audit requirement: exactly 100x160
      if (orientation === 6) {
        expect(uncropped.width).toBe(100);
        expect(uncropped.height).toBe(160);
      }

      // Verify uncropped pixel colors by inspecting with browser Canvas
      const uncroppedBytes = new Uint8Array(await uncropped.blob.arrayBuffer());
      expect(hasExifMetadata(uncroppedBytes)).toBe(false);
      expect(Buffer.from(uncroppedBytes).includes(Buffer.from("GPS"))).toBe(false);

      const uncroppedB64 = Buffer.from(uncroppedBytes).toString("base64");
      const pixels = await page.eval<{ tl: number[]; tr: number[]; bl: number[]; br: number[] }>(`(async () => {
        const bin = atob(${JSON.stringify(uncroppedB64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const b = new Blob([arr], { type: "image/jpeg" });
        const bmp = await createImageBitmap(b);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        const p = (x, y) => Array.from(data.subarray((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3));
        const res = {
          tl: p(10, 10),
          tr: p(bmp.width - 10, 10),
          bl: p(10, bmp.height - 10),
          br: p(bmp.width - 10, bmp.height - 10),
        };
        bmp.close();
        return res;
      })()`);

      expect(isRed(pixels.tl)).toBe(true);
      expect(isGreen(pixels.tr)).toBe(true);
      expect(isBlue(pixels.bl)).toBe(true);
      expect(isYellow(pixels.br)).toBe(true);

      // 2. Cropped processing (non-zero origin crop: x:20, y:24, w:60, h:80)
      const croppedResult = await processMenuImage(inputFile, {
        adapter,
        crop: {
          x: EXPECTED_CROP_X,
          y: EXPECTED_CROP_Y,
          width: EXPECTED_CROP_WIDTH,
          height: EXPECTED_CROP_HEIGHT,
          referenceWidth: EXPECTED_UPRIGHT_WIDTH,
          referenceHeight: EXPECTED_UPRIGHT_HEIGHT,
        },
      });
      expect(croppedResult.ok).toBe(true);
      if (!croppedResult.ok) return;

      const cropped = croppedResult.value;
      expect(cropped.width).toBe(EXPECTED_CROP_WIDTH);
      expect(cropped.height).toBe(EXPECTED_CROP_HEIGHT);
      expect(cropped.cropped).toBe(true);

      const croppedBytes = new Uint8Array(await cropped.blob.arrayBuffer());
      expect(hasExifMetadata(croppedBytes)).toBe(false);
      expect(Buffer.from(croppedBytes).includes(Buffer.from("GPS"))).toBe(false);

      const croppedB64 = Buffer.from(croppedBytes).toString("base64");
      const cropPixels = await page.eval<CropSamplePixels>(`(async () => {
        const bin = atob(${JSON.stringify(croppedB64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const b = new Blob([arr], { type: "image/jpeg" });
        const bmp = await createImageBitmap(b);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        const p = (x, y) => Array.from(data.subarray((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3));
        const res = {
          leftEdgeMid: p(0, Math.floor(bmp.height / 2)),
          rightEdgeMid: p(bmp.width - 1, Math.floor(bmp.height / 2)),
          topEdgeMid: p(Math.floor(bmp.width / 2), 0),
          bottomEdgeMid: p(Math.floor(bmp.width / 2), bmp.height - 1),
          center: p(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2)),
          topLeft: p(0, 0),
          topRight: p(bmp.width - 1, 0),
          bottomLeft: p(0, bmp.height - 1),
          bottomRight: p(bmp.width - 1, bmp.height - 1),
        };
        bmp.close();
        return res;
      })()`);

      assertCropBoundaryPixels(cropPixels, `Orientation ${orientation} adapter crop: `);
    });
  }
});
