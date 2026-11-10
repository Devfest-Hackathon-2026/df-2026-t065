import { IMAGE_CONSTRAINTS, type InvalidInputReason } from "@/contracts/analyze";

/*
 * Bounded reading of the multipart request body.
 *
 * `request.formData()` buffers the whole body before we can check sizes, and a
 * missing or false Content-Length cannot be trusted. We therefore:
 *   1. reject early when a declared Content-Length is already too large;
 *   2. read the body stream ourselves and stop (cancel) as soon as the byte
 *      count exceeds MAX_MULTIPART_BYTES, whatever Content-Length said;
 *   3. only then parse the (small, bounded) buffer as multipart/form-data.
 * Memory use is bounded by MAX_MULTIPART_BYTES per request.
 */

/** Whole multipart body limit: the 4 MiB image plus room for boundaries and text fields. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_MULTIPART_BYTES = IMAGE_CONSTRAINTS.maxBytes + MULTIPART_OVERHEAD_BYTES;

export type BodyReadResult = { ok: true; form: FormData } | { ok: false; reason: InvalidInputReason };

/**
 * Proposed read deadlines (to be approved with the other operating limits, D-008):
 *  - idle 15 s: no byte received for 15 s → the upload is treated as stalled.
 *  - total 60 s: hard cap even for a trickle that never goes idle. A total-only
 *    15 s limit would reject legitimate slow mobile uploads of a few MB.
 *  - cancel wait 1 s: reader.cancel() is not awaited longer than this.
 */
export const BODY_READ_LIMITS = { idleTimeoutMs: 15_000, totalTimeoutMs: 60_000, cancelWaitMs: 1_000 } as const;
export type BodyReadLimits = { idleTimeoutMs: number; totalTimeoutMs: number; cancelWaitMs: number };

const TIMED_OUT = Symbol("timed_out");

export async function readBoundedMultipart(
  req: Request,
  maxBytes: number = MAX_MULTIPART_BYTES,
  limits: BodyReadLimits = BODY_READ_LIMITS,
): Promise<BodyReadResult> {
  // A declared size above the limit is rejected before anything else is read.
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, reason: "malformed_request" };
    if (Number(declared) > maxBytes) return { ok: false, reason: "image_too_large" };
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    return { ok: false, reason: "malformed_request" };
  }

  if (!req.body) return { ok: false, reason: "malformed_request" };

  const reader = req.body.getReader();
  let chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + limits.totalTimeoutMs;

  /** Stops reading without ever waiting on a cancel() that may not settle. */
  const abandon = async () => {
    chunks = []; // drop buffered data immediately
    await Promise.race([reader.cancel().catch(() => undefined), sleep(limits.cancelWaitMs)]);
  };

  try {
    for (;;) {
      const wait = Math.min(limits.idleTimeoutMs, deadline - Date.now());
      if (wait <= 0) {
        await abandon();
        return { ok: false, reason: "malformed_request" };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), wait);
      });
      const result = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (result === TIMED_OUT) {
        // Stalled (idle) or too slow overall.
        await abandon();
        return { ok: false, reason: "malformed_request" };
      }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop reading immediately; do not buffer the rest.
        await abandon();
        return { ok: false, reason: "image_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // Client disconnected, truncated body, or a body shorter than its Content-Length.
    chunks = [];
    return { ok: false, reason: "malformed_request" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A read may still be pending on a stream whose cancel() did not settle; nothing else to release.
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }

  try {
    const form = await new Request("http://internal.invalid/", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, reason: "malformed_request" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type ImageType = (typeof IMAGE_CONSTRAINTS.mimeTypes)[number];

/**
 * Detects the real image type from its first bytes (magic numbers).
 * Returns null for anything that is not a JPEG, PNG or WebP file.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = (i: number) => bytes[i];
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b(i) === v)
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(b(0)!, b(1)!, b(2)!, b(3)!) === "RIFF" &&
    String.fromCharCode(b(8)!, b(9)!, b(10)!, b(11)!) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export type VerifiedImage = { ok: true; bytes: Uint8Array; mimeType: ImageType } | { ok: false; reason: InvalidInputReason };

/**
 * Reads the (already size-checked) image and verifies that its content matches
 * the declared MIME type. Disguised files are never sent to the model.
 */
export async function verifyImage(image: Blob): Promise<VerifiedImage> {
  if (image.size === 0) return { ok: false, reason: "image_missing" };
  if (image.size > IMAGE_CONSTRAINTS.maxBytes) return { ok: false, reason: "image_too_large" };
  const bytes = new Uint8Array(await image.arrayBuffer());
  const detected = sniffImageType(bytes);
  if (detected === null || detected !== image.type) return { ok: false, reason: "unsupported_image_type" };
  return { ok: true, bytes, mimeType: detected };
}
