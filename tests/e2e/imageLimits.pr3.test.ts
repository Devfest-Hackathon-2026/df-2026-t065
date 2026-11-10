import { describe, expect, it, vi } from "vitest";
import { IMAGE_CONSTRAINTS } from "@/contracts/analyze";
import { processMenuImage, readImageDimensions, SOURCE_IMAGE_LIMITS, type ImageTranscodeAdapter } from "@/client/imageProcessor";

// _notice: SYNTHETIC TEST DATA: header fixtures only; adapters replace pixel decoding.
function png(width = 4000, height = 4000, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}
function adapter(outputBytes = 64): ImageTranscodeAdapter {
  return {
    decode: vi.fn(async () => ({ width: 4000, height: 4000, source: {}, orientationAlreadyApplied: true })),
    renderToBlob: vi.fn(async () => {
      const bytes = new Uint8Array(outputBytes);
      bytes.set([255, 216, 255, 218]);
      return new Blob([bytes], { type: "image/jpeg" });
    }),
  };
}

describe("source resource limits are separate from the 4 MiB API limit", () => {
  it.each([IMAGE_CONSTRAINTS.maxBytes - 1, IMAGE_CONSTRAINTS.maxBytes, IMAGE_CONSTRAINTS.maxBytes + 1, SOURCE_IMAGE_LIMITS.maxBytes])(
    "accepts %i source bytes when the processed payload fits", async (bytes) => {
      const result = await processMenuImage(png(4000, 4000, bytes), { adapter: adapter() });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected processed image");
      expect(result.value.originalBytes).toBe(bytes);
      expect(result.value.processedBytes).toBe(64);
    });

  it("rejects source bytes above 20 MiB before reading or decoding", async () => {
    const file = png(4000, 4000, SOURCE_IMAGE_LIMITS.maxBytes + 1);
    const read = vi.spyOn(file, "arrayBuffer");
    const a = adapter();
    expect(await processMenuImage(file, { adapter: a })).toEqual({ ok: false, reason: "image_too_large" });
    expect(read).not.toHaveBeenCalled();
    expect(a.decode).not.toHaveBeenCalled();
  });

  it.each([[4000, 4000, true], [4001, 4000, false], [8192, 1, true], [8193, 1, false], [0, 10, false], [0xffffffff, 0xffffffff, false]])(
    "checks %i x %i before decoding (accepted=%s)", async (width, height, accepted) => {
      const a = adapter();
      const result = await processMenuImage(png(width, height), { adapter: a });
      expect(result.ok).toBe(accepted);
      expect(a.decode).toHaveBeenCalledTimes(accepted ? 1 : 0);
    });

  it.each([IMAGE_CONSTRAINTS.maxBytes - 1, IMAGE_CONSTRAINTS.maxBytes, IMAGE_CONSTRAINTS.maxBytes + 1])(
    "checks final encoded bytes %i against the unchanged API maximum", async (bytes) => {
      const a = adapter(bytes);
      const result = await processMenuImage(png(), { adapter: a, maxBytes: SOURCE_IMAGE_LIMITS.maxBytes });
      expect(result.ok).toBe(bytes <= IMAGE_CONSTRAINTS.maxBytes);
    });

  it("checks size after EXIF removal", async () => {
    const a = adapter();
    a.renderToBlob = async () => {
      const head = new Uint8Array([255, 216, 255, 225, 0, 10, 69, 120, 105, 102, 0, 0, 0, 0, 255, 218]);
      return new Blob([head, new Uint8Array(IMAGE_CONSTRAINTS.maxBytes - head.length + 5)], { type: "image/jpeg" });
    };
    const result = await processMenuImage(png(), { adapter: a });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected stripped image");
    expect(result.value.processedBytes).toBeLessThanOrEqual(IMAGE_CONSTRAINTS.maxBytes);
  });

  it.each([[Infinity, 1], [1, NaN], [1, 0], [1.5, 20], [4001, 4000], [8193, 1]])(
    "rejects invalid decoded dimensions %s x %s and closes the decoder", async (width, height) => {
      const close = vi.fn();
      const a = adapter();
      a.decode = async () => ({ width, height, source: {}, orientationAlreadyApplied: true, close });
      expect(await processMenuImage(png(), { adapter: a })).toEqual({ ok: false, reason: "image_too_large" });
      expect(a.renderToBlob).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    });

  it("fails closed for truncated headers, decode failures and read failures", async () => {
    const a = adapter();
    expect(await processMenuImage(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), { adapter: a }))
      .toEqual({ ok: false, reason: "unsupported_image_type" });
    expect(a.decode).not.toHaveBeenCalled();
    a.decode = async () => { throw new Error("corrupt pixels"); };
    expect(await processMenuImage(png(), { adapter: a })).toEqual({ ok: false, reason: "unsupported_image_type" });
    const unreadable = png();
    unreadable.arrayBuffer = async () => { throw new Error("read failed"); };
    expect(await processMenuImage(unreadable)).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("reads JPEG dimensions and rejects out-of-bounds segment lengths", () => {
    const bytes = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0x0f, 0xa0, 0x0f, 0xa0, 0]);
    expect(readImageDimensions(bytes)).toEqual({ width: 4000, height: 4000 });
    bytes[5] = 50;
    expect(readImageDimensions(bytes)).toBeNull();
  });

  it.each(["VP8 ", "VP8L", "VP8X"])("reads WebP %s dimensions without decoding", (kind) => {
    const size = kind === "VP8L" ? 6 : kind === "VP8X" ? 28 : 10;
    const bytes = new Uint8Array(20 + size);
    const view = new DataView(bytes.buffer);
    bytes.set(Buffer.from("RIFF")); view.setUint32(4, bytes.length - 8, true);
    bytes.set(Buffer.from("WEBP"), 8); bytes.set(Buffer.from(kind), 12);
    view.setUint32(16, kind === "VP8X" ? 10 : size, true);
    if (kind === "VP8L") { bytes[20] = 0x2f; view.setUint32(21, 3999 | (3999 << 14), true); }
    else {
      const offset = kind === "VP8X" ? 38 : 20;
      if (kind === "VP8X") {
        bytes.set([0x9f, 0x0f, 0], 24); bytes.set([0x9f, 0x0f, 0], 27);
        bytes.set(Buffer.from("VP8 "), 30); view.setUint32(34, 10, true);
      }
      bytes.set([0x9d, 1, 0x2a], offset + 3);
      view.setUint16(offset + 6, 4000, true); view.setUint16(offset + 8, 4000, true);
    }
    expect(readImageDimensions(bytes)).toEqual({ width: 4000, height: 4000 });
    if (kind === "VP8X") {
      bytes[24] = 0; expect(readImageDimensions(bytes)).toBeNull();
      bytes[20] = 2; expect(readImageDimensions(bytes)).toBeNull();
    }
  });
});
