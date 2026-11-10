import { describe, expect, it } from "vitest";
import { BODY_READ_LIMITS, readBoundedMultipart } from "@/server/requestBody";
import { blob, fakeJpeg } from "./helpers";

/*
 * mn-2 (PR2 audit): a stalled upload must not keep the handler waiting forever.
 * Short limits are injected so the tests run fast; production values are in BODY_READ_LIMITS.
 */

const URL_ = "http://localhost/api/analyze-menu";
const FAST = { idleTimeoutMs: 80, totalTimeoutMs: 400, cancelWaitMs: 50 };

async function encoded(): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const f = new FormData();
  f.append("userLang", "ja");
  f.append("storeLang", "en");
  f.append("allergens", "peanut");
  f.append("image", blob(fakeJpeg(2048), "image/jpeg"), "m.jpg");
  const r = new Request(URL_, { method: "POST", body: f });
  return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type")! };
}

function streamed(
  source: UnderlyingDefaultSource<Uint8Array>,
  contentType: string,
  headers: Record<string, string> = {},
): { req: Request; stream: ReadableStream<Uint8Array> } {
  const stream = new ReadableStream<Uint8Array>(source);
  const req = new Request(URL_, {
    method: "POST",
    body: stream,
    headers: { "content-type": contentType, ...headers },
    duplex: "half",
  } as RequestInit);
  return { req, stream };
}

/** Sends `bytes` in `parts` chunks, waiting `gapMs` between chunks. */
function trickle(bytes: Uint8Array, parts: number, gapMs: number): UnderlyingDefaultSource<Uint8Array> {
  const size = Math.ceil(bytes.length / parts);
  let i = 0;
  return {
    async pull(c) {
      if (i * size >= bytes.length) return c.close();
      if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
      c.enqueue(bytes.slice(i * size, (i + 1) * size));
      i++;
    },
  };
}

describe("mn-2: body read deadline", () => {
  it("documents the proposed production limits (idle 15 s, total 60 s)", () => {
    expect(BODY_READ_LIMITS).toEqual({ idleTimeoutMs: 15_000, totalTimeoutMs: 60_000, cancelWaitMs: 1_000 });
  });

  it("aborts a stream that stops sending (no Content-Length)", async () => {
    const { bytes, contentType } = await encoded();
    let sent = false;
    const { req } = streamed(
      {
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(bytes.slice(0, 100));
            return;
          }
          return new Promise(() => {}); // stalls forever
        },
      },
      contentType,
    );
    const t0 = Date.now();
    expect(await readBoundedMultipart(req, undefined, FAST)).toEqual({ ok: false, reason: "malformed_request" });
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it("aborts a stalled stream even when Content-Length is present", async () => {
    const { contentType } = await encoded();
    const { req } = streamed({ pull: () => new Promise(() => {}) }, contentType, { "content-length": "5000" });
    expect(await readBoundedMultipart(req, undefined, FAST)).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("returns even if reader.cancel() itself never settles", async () => {
    const { contentType } = await encoded();
    const { req } = streamed({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }, contentType);
    const t0 = Date.now();
    expect(await readBoundedMultipart(req, undefined, FAST)).toEqual({ ok: false, reason: "malformed_request" });
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it("enforces the total deadline against a slow trickle that never goes idle", async () => {
    const big = new Uint8Array(200_000);
    const { req } = streamed(trickle(big, 100, 30), "multipart/form-data; boundary=x"); // ~3 s total, 30 ms gaps
    const t0 = Date.now();
    expect(await readBoundedMultipart(req, undefined, FAST)).toEqual({ ok: false, reason: "malformed_request" });
    expect(Date.now() - t0).toBeLessThan(700);
  });

  it("accepts a normal slow upload (gaps shorter than the idle limit)", async () => {
    const { bytes, contentType } = await encoded();
    const { req } = streamed(trickle(bytes, 5, 40), contentType); // 5 chunks, 40 ms gaps < 80 ms idle
    const r = await readBoundedMultipart(req, undefined, FAST);
    expect(r.ok).toBe(true);
  });

  it("accepts an upload that completes just before the total deadline", async () => {
    const { bytes, contentType } = await encoded();
    const { req } = streamed(trickle(bytes, 6, 60), contentType); // ~300 ms total < 400 ms, gaps 60 ms < 80 ms
    const r = await readBoundedMultipart(req, undefined, FAST);
    expect(r.ok).toBe(true);
  });

  it("still enforces the size limit before the deadline", async () => {
    const { req } = streamed(trickle(new Uint8Array(6 * 1024 * 1024), 6, 1), "multipart/form-data; boundary=x");
    expect(await readBoundedMultipart(req, undefined, FAST)).toEqual({ ok: false, reason: "image_too_large" });
  });

  it("treats a client disconnect as malformed_request", async () => {
    const { contentType } = await encoded();
    let n = 0;
    const { req } = streamed(
      {
        pull(c) {
          if (n++ === 0) c.enqueue(new Uint8Array(10));
          else c.error(new Error("socket hang up"));
        },
      },
      contentType,
    );
    expect(await readBoundedMultipart(req, undefined, FAST)).toEqual({ ok: false, reason: "malformed_request" });
  });

  it("releases the stream after a timeout (no reader left holding it)", async () => {
    const { contentType } = await encoded();
    const { req, stream } = streamed({ pull: () => new Promise(() => {}) }, contentType);
    await readBoundedMultipart(req, undefined, FAST);
    // Either cancelled or unlocked: in both cases nothing keeps reading or buffering.
    expect(stream.locked).toBe(false);
  });
});
