import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productionSubject, type Subject } from "./engine";
import { buildReport, renderMarkdown } from "./report";
import {
  FORMAT_SAMPLE_NOTICE_PREFIX,
  RECORDED_NOTICE_PREFIX,
  SYNTHETIC_IMAGE_REFERENCES,
  evaluateRecorded,
  loadRecordedDir,
  parseRecorded,
  type RecordedOutput,
  type SyntheticImageReference,
} from "./recorded";

/*
 * Extension point for recorded real-model outputs. Everything below uses
 * FORMAT SAMPLES written by the team (source "format_sample", model "none"):
 * they are NOT real Gemini output and say nothing about real-model accuracy.
 *
 * Evaluate approved recorded files (later, offline):
 *   EVAL_RECORDED_DIR=<dir> npx vitest run tests/server/evaluation/recorded.test.ts
 *   → test-results/offline-eval/recorded-report.{json,md}
 */

const SHA = "a".repeat(64);
const MENU = "Sesame Noodles with soy dressing";

const sample = (over: Partial<RecordedOutput> = {}): RecordedOutput =>
  ({
    _notice: `${FORMAT_SAMPLE_NOTICE_PREFIX}. Not real Gemini output.`,
    source: "format_sample",
    model: "none",
    schemaVersion: 1,
    syntheticImageId: "SYN-IMG-01",
    imageSha256: SHA,
    capturedAt: "2026-11-09T00:00:00Z",
    input: { userLang: "ja", storeLang: "en", allergens: ["sesame", "soy", "wheat"] },
    modelText: JSON.stringify({
      status: "ok",
      imageIssues: [],
      items: [
        {
          readText: MENU,
          readability: "clear",
          allergens: [
            { code: "sesame", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "Sesame" },
            { code: "soy", category: "menu_mentions", mentionKind: "contains_claim", excerpt: "soy dressing" },
            { code: "wheat", category: "ai_inferred", rationale: "Noodles are often made from wheat." },
          ],
        },
      ],
      menuNotices: [],
    }),
    ...over,
  }) as RecordedOutput;

const REF: SyntheticImageReference = {
  syntheticImageId: "SYN-IMG-01",
  imageSha256: SHA,
  coverage: ["explicit_contains"],
  items: [{ menuText: MENU, labels: { sesame: "menu_mentions:contains_claim", soy: "menu_mentions:contains_claim", wheat: "ai_inferred" } }],
};

describe("recorded-output format", () => {
  it("accepts a format sample and keeps the reference registry empty until images are approved", () => {
    expect(parseRecorded(JSON.stringify(sample()))).toMatchObject({ ok: true });
    expect(SYNTHETIC_IMAGE_REFERENCES).toEqual([]);
  });

  it("accepts a recorded file only with an approval for exactly the model used", () => {
    const rec = { ...sample(), _notice: `${RECORDED_NOTICE_PREFIX}: SYN-IMG-01`, source: "recorded_gemini", model: "approved-model" };
    expect(parseRecorded(JSON.stringify({ ...rec, approval: { ref: "D-0XX", approvedModel: "approved-model" } }))).toMatchObject({ ok: true });
    expect(parseRecorded(JSON.stringify({ ...rec, approval: { ref: "D-0XX", approvedModel: "other-model" } }))).toMatchObject({ ok: false, problem: "schema" });
    expect(parseRecorded(JSON.stringify(rec))).toMatchObject({ ok: false, problem: "schema" });
  });

  it.each([
    ["a cost field", { costUsd: 0.01 }],
    ["an image payload", { imageBase64: "AAAA" }],
    ["a credential-like field", { accessToken: "x" }],
    ["a non-synthetic image id", { syntheticImageId: "store-photo-1" }],
    ["a missing notice", { _notice: "real menu" }],
  ])("rejects %s", (_name, over) => {
    expect(parseRecorded(JSON.stringify({ ...sample(), ...over }))).toMatchObject({ ok: false, problem: "schema" });
  });

  it("rejects duplicate keys with the production strict parser", () => {
    const text = JSON.stringify(sample()).replace('"modelText":', '"modelText":"x","modelText":');
    expect(parseRecorded(text)).toMatchObject({ ok: false, problem: "duplicate_key" });
  });
});

describe("evaluation of recorded outputs (offline replay)", () => {
  it("runs the same safety checks and reports accuracy against the reference", async () => {
    const misread = sample({ syntheticImageId: "SYN-IMG-02" });
    misread.modelText = misread.modelText.replace(MENU, "Sesame Nodles with soy dressing");
    const refs = [REF, { ...REF, syntheticImageId: "SYN-IMG-02" }];
    const { results } = await evaluateRecorded([sample(), misread], refs);
    for (const r of results) {
      const failed = r.checks.filter((c) => c.status === "fail");
      expect(failed, r.id).toEqual([]);
      // no pipeline expectation / injected-defect check for real outputs
      expect(r.checks.find((c) => c.invariant === "PIPELINE-EXPECTATION")!.status).toBe("not_applicable");
      expect(r.checks.find((c) => c.invariant === "ACCURACY-DETECTION")!.status).toBe("not_applicable");
    }
    expect(results[0]!.accuracyFindings).toEqual([]);
    expect(results[0]!.status).toBe("pass");
    expect(results[1]!.accuracyFindings).toEqual(["items[0].readText_mismatch"]);
  });

  it("marks accuracy as unverified without a matching reference", async () => {
    const { results } = await evaluateRecorded([sample()], []);
    expect(results[0]!.status).toBe("unverified");
    const { results: r2 } = await evaluateRecorded([sample()], [{ ...REF, imageSha256: "b".repeat(64) }]);
    expect(r2[0]!.status).toBe("unverified");
    expect(r2[0]!.accuracyFindings).toEqual([]);
  });

  it("still fails closed on a broken recorded output", async () => {
    const { results } = await evaluateRecorded([sample({ modelText: '{"status":"ok"' })], [REF]);
    expect(results[0]!.observed).toMatchObject({ outcome: "rejected", errorCode: "AI_FAILED", failure: "model_invalid_json" });
    expect(results[0]!.accuracyFindings).toEqual(["rejected_fail_closed"]);
    expect(results[0]!.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  const dir = process.env.EVAL_RECORDED_DIR;
  it.skipIf(!dir)("evaluates the recorded files in EVAL_RECORDED_DIR and writes a report", async () => {
    const loaded = loadRecordedDir(dir!);
    const bad = loaded.filter((l) => !l.ok);
    expect(bad, "invalid recorded files").toEqual([]);
    const records = loaded.flatMap((l) => (l.ok ? [l.record] : []));
    let networkCalls = 0;
    const counted: Subject = async (c) => {
      const run = await productionSubject(c);
      networkCalls += run.networkCalls;
      return run;
    };
    const { cases, results } = await evaluateRecorded(records, undefined, counted);
    expect(networkCalls).toBe(0);
    const report = buildReport(results, cases, { networkCalls, mode: "recorded_outputs" });
    const out = resolve(__dirname, "../../../test-results/offline-eval");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "recorded-report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(out, "recorded-report.md"), renderMarkdown(report));
  });
});
