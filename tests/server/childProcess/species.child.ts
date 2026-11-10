import { expect, it } from "vitest";
import type { GeminiConfig } from "@/server/config";
import { analyzeWithGemini, type ReserveAttempt } from "@/server/gemini/analyzeWithGemini";
import { UsageGuard } from "@/server/usage/guard";
import type { UsageStore } from "@/server/usage/store";
import { scenarios } from "./speciesScenarios";

/*
 * Separate-Node-process scenario for the Promise subclass / Symbol.species
 * audit (run by tests/server/promiseSpecies.test.ts). Asynchronous errors are
 * watched until the END of the test (after a quiet period), on both paths.
 */

const CFG: GeminiConfig = { project: "p", location: "asia-northeast1", model: "m", attemptTimeoutMs: 1000, requestDeadlineMs: 8000, maxOutputTokens: 4096 };
const REQ = { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" as const, userLang: "ja", storeLang: "en", allergens: ["peanut" as const] };
const T = Date.UTC(2026, 10, 6, 15, 0, 0) + 3_600_000;
const PERMIT = { decision: "allowed", validFromMs: Date.UTC(2026, 10, 6, 15, 0, 0), validUntilMs: Date.UTC(2026, 10, 7, 15, 0, 0) };

it("Promise subclasses / species: refused on both paths without async errors", async () => {
  const asyncErrors: string[] = [];
  process.on("unhandledRejection", () => void asyncErrors.push("unhandledRejection"));
  process.on("uncaughtException", () => void asyncErrors.push("uncaughtException"));
  const wrong: string[] = [];
  for (const s of scenarios()) {
    // reservation hook path
    let starts = 0;
    const model = { generate: async () => (starts++, { text: "{}", finishReason: "STOP" }) };
    const out1 = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: T + 8_000, reserveAttempt: (() => s.make(PERMIT)) as unknown as ReserveAttempt }, { now: () => T });
    if (s.refuse && (starts !== 0 || out1.ok || out1.failure !== "usage_store_error" || out1.reservationsUnknown !== 1)) wrong.push(`hook: ${s.name}`);
    // UsageStore path
    starts = 0;
    const g = new UsageGuard({ kind: "u", consume: () => s.make({ allowed: true, count: 1 }) } as unknown as UsageStore, { dailyInferenceLimit: 10, ratePerMinute: 60, trustedProxyHops: 0 }, () => T);
    const rate = await g.checkRate("c", T + 8_000);
    const out2 = await analyzeWithGemini(model, CFG, REQ, { requestId: "r", deadlineAt: T + 8_000, reserveAttempt: (d) => g.reserveInference(d) }, { now: () => T });
    if (s.refuse && (starts !== 0 || rate !== "store_error" || out2.ok || out2.failure !== "usage_store_error" || out2.reservationsUnknown !== 1)) wrong.push(`store: ${s.name}`);
    if (s.getterCalls && s.getterCalls() !== 0) wrong.push(`getter ran: ${s.name}`);
  }
  // Watch until the end: give every pending job and timer a chance to fail.
  await new Promise((r) => setTimeout(r, 300));
  expect(wrong).toEqual([]);
  expect(asyncErrors).toEqual([]);
});
