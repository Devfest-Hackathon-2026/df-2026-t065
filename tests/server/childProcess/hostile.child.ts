import { expect, it } from "vitest";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import { UsageGuard } from "@/server/usage/guard";
import type { UsageStore } from "@/server/usage/store";

/*
 * Child-process scenarios for MAJOR-B (run by prod12Revise2.test.ts in its own
 * Node process). Every hostile value must fail closed WITHOUT an
 * unhandledRejection or uncaughtException in this process. SYNTHETIC values only.
 */

const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const REQ = { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const T = Date.UTC(2026, 10, 6, 15, 0, 0);
const PERMIT = { decision: "allowed", validFromMs: T, validUntilMs: T + 86_400_000 };

function revokeOnThen<V extends object>(target: V): V {
  const { proxy, revoke } = Proxy.revocable(target, {
    get(t, k, r) {
      if (k === "then") queueMicrotask(revoke);
      return Reflect.get(t, k, r);
    },
  });
  return proxy;
}
function revoked<V extends object>(target: V): V {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

it("hostile permits and store results never produce an unhandled rejection or exception", async () => {
  const unhandled: unknown[] = [];
  process.on("unhandledRejection", (r) => void unhandled.push(r));
  process.on("uncaughtException", (e) => void unhandled.push(e));
  let calls = 0;
  const model = { generate: async () => (calls++, { text: "{}", finishReason: "STOP" }) };
  const permits = [() => revokeOnThen(PERMIT), () => revoked(PERMIT), () => new Proxy(PERMIT, { ownKeys: () => { throw new Error("x"); } })];
  const results = [() => revokeOnThen({ allowed: true, count: 1 }), () => revoked({ allowed: true, count: 1 })];
  const outcomes: string[] = [];
  for (const make of permits) {
    for (const hook of [(async () => make()) as unknown as ReserveAttempt, (() => make()) as unknown as ReserveAttempt]) {
      const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: T + 8_000, reserveAttempt: hook }, { now: () => T });
      outcomes.push(out.ok ? "ok" : out.failure);
    }
  }
  for (const make of results) {
    for (const store of [{ kind: "a", consume: async () => make() } as unknown as UsageStore, { kind: "s", consume: () => make() } as unknown as UsageStore]) {
      const g = new UsageGuard(store, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, () => T);
      const out = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: T + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: () => T });
      outcomes.push(out.ok ? "ok" : out.failure);
      outcomes.push(await g.checkRate("c", T + 8_000));
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  expect(calls).toBe(0);
  expect(new Set(outcomes)).toEqual(new Set(["usage_store_error", "store_error"]));
  expect(unhandled).toEqual([]);
});
