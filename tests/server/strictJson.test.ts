import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MODEL_JSON_BYTES, MAX_MODEL_JSON_DEPTH, MAX_MODEL_JSON_VALUES, parseStrictJson } from "@/server/gemini/strictJson";

/*
 * Strict JSON parser for model output (PR5 safety audit, MAJOR). Inputs are SYNTHETIC.
 */

describe("strict JSON parser: same values as JSON.parse for valid, duplicate-free input", () => {
  it.each([
    "{}",
    "[]",
    '""',
    "0",
    "-0.5e+10",
    "1E-2",
    "true",
    "false",
    "null",
    ' \t\r\n{ "a" : [ 1 , 2 , { "b" : null } ] } \n',
    '{"s":"q\\"b\\\\s\\/n\\n t\\t r\\r b\\b f\\f u\\u00e9 \\ud83e\\udd5c 日本語"}',
    '{"a":{"a":{"a":1}},"b":[{"a":1},{"a":2}]}',
    '{"":1," ":2}',
    '{"text":"\\"allergens\\": [] , \\"x\\":1"}',
    '{"lone":"\\ud800"}',
  ])("%s", (text) => {
    expect(parseStrictJson(text)).toEqual({ ok: true, value: JSON.parse(text) });
  });

  it("creates __proto__ / constructor as own data properties, never touching a prototype", () => {
    const r = parseStrictJson('{"__proto__":{"polluted":true},"constructor":1}');
    expect(r.ok).toBe(true);
    const v = (r as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(v, "__proto__")?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(v).toEqual(JSON.parse('{"__proto__":{"polluted":true},"constructor":1}'));
  });
});

describe("strict JSON parser: duplicate keys", () => {
  it.each([
    '{"a":1,"a":1}',
    '{"a":1,"a":2}',
    '{"x":{"a":1,"a":[]}}',
    '[{"ok":1},{"a":1,"b":2,"a":3}]',
    '{"aller\\u0067ens":[],"allergens":[]}',
    '{"\\u0061":1,"a":2}',
    '{"\\/":1,"/":2}',
    '{"\\ud83e\\udd5c":1,"\u{1F95C}":2}',
    '{"__proto__":1,"__proto__":2}',
  ])("%s → duplicate_key", (text) => {
    expect(parseStrictJson(text)).toEqual({ ok: false, issue: "duplicate_key" });
  });
  it("keys that only LOOK alike are different keys", () => {
    expect(parseStrictJson('{"a":1,"A":2,"a ":3,"\\u0062":4}').ok).toBe(true);
  });
});

describe("strict JSON parser: rejects what JSON.parse rejects, and more than one document", () => {
  it.each([
    "",
    " ",
    "{",
    '{"a":1,}',
    "[1,]",
    "[1 2]",
    '{"a" 1}',
    "{a:1}",
    "{'a':1}",
    '"unterminated',
    '"bad \\x escape"',
    '"bad \\u12 escape"',
    '"raw\nnewline"',
    "01",
    "1.",
    ".5",
    "+1",
    "NaN",
    "Infinity",
    "tru",
    "nul",
    "﻿{}",
    "{} {}",
    "{}{}",
    "[] x",
    "// c\n{}",
    "1e999",
  ])("%j → invalid_json", (text) => {
    expect(parseStrictJson(text)).toEqual({ ok: false, issue: "invalid_json" });
  });
});

describe("strict JSON parser: bounded CPU and memory", () => {
  it("rejects input longer than the limit before parsing", () => {
    expect(parseStrictJson(" ".repeat(MAX_MODEL_JSON_BYTES) + "1")).toEqual({ ok: false, issue: "too_large" });
  });
  it("rejects nesting deeper than the limit (no stack overflow)", () => {
    expect(parseStrictJson("[".repeat(MAX_MODEL_JSON_DEPTH) + "]".repeat(MAX_MODEL_JSON_DEPTH)).ok).toBe(true);
    expect(parseStrictJson("[".repeat(MAX_MODEL_JSON_DEPTH + 1) + "]".repeat(MAX_MODEL_JSON_DEPTH + 1))).toEqual({ ok: false, issue: "too_deep" });
    expect(parseStrictJson('{"a":'.repeat(100_000))).toEqual({ ok: false, issue: "too_deep" });
  });
  it("rejects too many values", () => {
    expect(parseStrictJson(`[${"0,".repeat(MAX_MODEL_JSON_VALUES)}0]`)).toEqual({ ok: false, issue: "too_large" });
  });
  it("parses a maximum-size object with many keys in linear time", () => {
    const keys = Array.from({ length: 20_000 }, (_, i) => `"k${i}":${i}`).join(",");
    const t0 = Date.now();
    expect(parseStrictJson(`{${keys}}`).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("the model text has exactly one parse step, and it is the strict one", () => {
  it("analyzeWithGemini does not call JSON.parse", () => {
    const src = readFileSync(join(process.cwd(), "src/server/gemini/analyzeWithGemini.ts"), "utf8");
    expect(src).not.toMatch(/JSON\.parse\s*\(/);
    expect(src).toMatch(/parseStrictJson\(call\.text\)/);
  });
});
