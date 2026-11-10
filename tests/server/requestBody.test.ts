import { describe, expect, it } from "vitest";
import { IMAGE_CONSTRAINTS } from "@/contracts/analyze";
import { MAX_MULTIPART_BYTES, readBoundedMultipart, sniffImageType, verifyImage } from "@/server/requestBody";
import { blob, fakeJpeg, fakePng, fakeWebp } from "./helpers";

const URL_ = "http://localhost/api/analyze-menu";

/** Serializes a FormData to bytes + content-type (as a browser would send it). */
async function encode(form: FormData): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const r = new Request(URL_, { method: "POST", body: form });
  return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type")! };
}

function smallForm(): FormData {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(), "image/jpeg"), "m.jpg");
  return f;
}

/** A streamed body with NO Content-Length header; records how many chunks were pulled. */
function streamingRequest(chunks: Uint8Array[], contentType: string, opts: { failAfter?: number } = {}) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && pulled >= opts.failAfter) {
        controller.error(new Error("client disconnected"));
        return;
      }
      const c = chunks[pulled++];
      if (c) controller.enqueue(c);
      else controller.close();
    },
  });
  const req = new Request(URL_, {
    method: "POST",
    body: stream,
    headers: { "content-type": contentType },
    duplex: "half",
  } as RequestInit);
  return { req, pulled: () => pulled };
}

describe("readBoundedMultipart", () => {
  it("parses a normal multipart body", async () => {
    const { bytes, contentType } = await encode(smallForm());
    const r = await readBoundedMultipart(new Request(URL_, { method: "POST", body: bytes, headers: { "content-type": contentType } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.form.get("userLang")).toBe("ja");
  });

  it("parses a normal streamed body without Content-Length", async () => {
    const { bytes, contentType } = await encode(smallForm());
    const { req } = streamingRequest([bytes.slice(0, 50), bytes.slice(50)], contentType);
    expect(req.headers.get("content-length")).toBeNull();
    expect((await readBoundedMultipart(req)).ok).toBe(true);
  });

  it("stops reading a large body WITHOUT Content-Length as soon as the limit is passed", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    const chunks = Array.from({ length: 50 }, () => chunk); // 50 MiB offered
    const { req, pulled } = streamingRequest(chunks, "multipart/form-data; boundary=x");
    expect(await readBoundedMultipart(req)).toEqual({ ok: false, reason: "image_too_large" });
    // 4 MiB + 64 KiB limit → stopped after the 5th MiB, not after 50.
    expect(pulled()).toBeLessThanOrEqual(6);
  });

  it("does not trust a false (too small) Content-Length", async () => {
    const big = new Uint8Array(MAX_MULTIPART_BYTES + 1);
    const { req } = streamingRequest([big], "multipart/form-data; boundary=x");
    req.headers.set("content-length", "100"); // the client claims 100 bytes but sends > 4 MiB
    expect(req.headers.get("content-length")).toBe("100");
    expect(await readBoundedMultipart(req)).toEqual({ ok: false, reason: "image_too_large" });
  });

  it("rejects a declared Content-Length above the limit before reading", async () => {
    const req = new Request(URL_, {
      method: "POST",
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_MULTIPART_BYTES + 1) },
    });
    expect(await readBoundedMultipart(req)).toEqual({ ok: false, reason: "image_too_large" });
  });

  it("rejects a non-numeric Content-Length", async () => {
    const req = new Request(URL_, {
      method: "POST",
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "1e9" },
    });
    expect(await readBoundedMultipart(req)).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("rejects a body that is cut off mid-stream (client disconnect)", async () => {
    const { bytes, contentType } = await encode(smallForm());
    const { req } = streamingRequest([bytes.slice(0, 40), bytes.slice(40)], contentType, { failAfter: 1 });
    expect(await readBoundedMultipart(req)).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("rejects a truncated multipart body (missing closing boundary)", async () => {
    const { bytes, contentType } = await encode(smallForm());
    const r = await readBoundedMultipart(
      new Request(URL_, { method: "POST", body: bytes.slice(0, bytes.length - 30), headers: { "content-type": contentType } }),
    );
    expect(r).toEqual({ ok: false, reason: "malformed_request" });
  });

  it.each([
    ["JSON", "application/json"],
    ["urlencoded", "application/x-www-form-urlencoded"],
    ["multipart without boundary", "multipart/form-data"],
    ["missing", ""],
  ])("rejects a non-multipart content type (%s)", async (_n, ct) => {
    const headers: Record<string, string> = ct ? { "content-type": ct } : {};
    const r = await readBoundedMultipart(new Request(URL_, { method: "POST", body: "{}", headers }));
    expect(r).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("rejects a missing body", async () => {
    const r = await readBoundedMultipart(new Request(URL_, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" } }));
    expect(r).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("defines the multipart limit as 4 MiB image + 64 KiB overhead", () => {
    expect(IMAGE_CONSTRAINTS.maxBytes).toBe(4 * 1024 * 1024);
    expect(MAX_MULTIPART_BYTES).toBe(4 * 1024 * 1024 + 64 * 1024);
  });
});

describe("image verification (magic bytes)", () => {
  it.each([
    ["JPEG", fakeJpeg(), "image/jpeg"],
    ["PNG", fakePng(), "image/png"],
    ["WebP", fakeWebp(), "image/webp"],
  ])("detects %s", async (_n, bytes, type) => {
    expect(sniffImageType(bytes)).toBe(type);
    const v = await verifyImage(blob(bytes, type));
    expect(v.ok && v.mimeType).toBe(type);
  });

  it.each([
    ["PNG bytes declared as JPEG", fakePng(), "image/jpeg"],
    ["JPEG bytes declared as WebP", fakeJpeg(), "image/webp"],
    ["text declared as JPEG", new TextEncoder().encode("<svg onload=alert(1)>"), "image/jpeg"],
    ["GIF bytes declared as PNG", new TextEncoder().encode("GIF89a........"), "image/png"],
    ["RIFF but not WEBP (e.g. WAV)", new TextEncoder().encode("RIFF....WAVEfmt "), "image/webp"],
    ["truncated JPEG signature", new Uint8Array([0xff, 0xd8]), "image/jpeg"],
  ])("rejects a disguised file: %s", async (_n, bytes, type) => {
    expect(await verifyImage(blob(bytes, type))).toEqual({ ok: false, reason: "unsupported_image_type" });
  });

  it("rejects an image over 4 MiB and accepts exactly 4 MiB", async () => {
    expect(await verifyImage(blob(fakeJpeg(IMAGE_CONSTRAINTS.maxBytes + 1), "image/jpeg"))).toEqual({
      ok: false,
      reason: "image_too_large",
    });
    expect((await verifyImage(blob(fakeJpeg(IMAGE_CONSTRAINTS.maxBytes), "image/jpeg"))).ok).toBe(true);
  });

  it("rejects an empty image", async () => {
    expect(await verifyImage(blob(new Uint8Array(0), "image/jpeg"))).toEqual({ ok: false, reason: "image_missing" });
  });
});
