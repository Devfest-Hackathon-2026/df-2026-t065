/*
 * Test helpers: SYNTHETIC image bytes (valid file signatures + padding).
 * They are not real photos; they only need the correct magic bytes.
 */

export function fakeJpeg(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

export function fakePng(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

export function fakeWebp(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)));
  b.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  return b;
}

export function blob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
}

import { UsageGuard } from "@/server/usage/guard";
import { InMemoryUsageStore } from "@/server/usage/store";

/**
 * TEST ONLY: a usage guard with generous limits, for tests that exercise other
 * behaviour. Guard behaviour itself is tested in usageGuards.test.ts.
 */
export function testUsageGuard(now?: () => number): UsageGuard {
  const t = now ?? (() => Date.now());
  return new UsageGuard(new InMemoryUsageStore(t), { dailyInferenceLimit: 10_000, ratePerMinute: 60, trustedProxyHops: 0 }, t);
}

/**
 * TEST ONLY: a confirmed reservation whose permit never expires (for tests of
 * other behaviour). Day-boundary behaviour is tested in prod12.test.ts.
 */
export const PERMIT = { decision: "allowed", validFromMs: 0, validUntilMs: 8_640_000_000_000_000 } as const;
