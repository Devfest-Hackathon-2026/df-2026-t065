/*
 * Strict JSON parser for model output (PR5 safety audit, MAJOR).
 *
 * `JSON.parse` keeps only the LAST of duplicate keys, so
 * `{"allergens":[<menu mention>],"allergens":[]}` silently loses a menu
 * mention and the response still validates. This parser is the ONLY place the
 * model's JSON text is turned into a value, and it rejects that:
 *
 *  - RFC 8259 grammar (same accepted language as JSON.parse: no comments, no
 *    trailing commas, no leading BOM, exactly one document followed only by
 *    whitespace — two documents are rejected).
 *  - Duplicate keys are rejected in EVERY object, compared after escape
 *    decoding ("allergens" and "allergens" are the same key). The same
 *    key name in different objects is fine.
 *  - Bounded: the input size is checked in UTF-8 BYTES before parsing (a
 *    UTF-16 length check would let multibyte text exceed the limit up to 3×),
 *    then nesting depth and the number of values are limited during the single
 *    linear pass.
 *  - `__proto__` and other keys are created as own data properties
 *    (never invoking a setter, never changing a prototype).
 *
 * No dependency. Errors are reduced to an enum; no input text is ever returned.
 */

/**
 * Maximum input size in UTF-8 BYTES (512 KiB). Larger than any output the
 * configured token cap (≤ 16,384 tokens) can produce. A lone surrogate counts as
 * 3 bytes (UTF-8 encoding replaces it with U+FFFD).
 */
export const MAX_MODEL_JSON_BYTES = 512 * 1024;
/** The model response schema nests 5 levels; anything deeper is not ours. */
export const MAX_MODEL_JSON_DEPTH = 32;
/** Upper bound on values (objects, arrays, strings, numbers, literals). */
export const MAX_MODEL_JSON_VALUES = 50_000;

export type StrictJsonIssue = "invalid_json" | "duplicate_key" | "too_large" | "too_deep";
export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; issue: StrictJsonIssue };

class StrictJsonError extends Error {
  constructor(readonly issue: StrictJsonIssue) {
    super(issue);
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

export type StrictJsonLimits = { maxBytes?: number };

/**
 * `limits.maxBytes` lets a caller with a different, documented bound (the raw
 * HTTP body check in vertexClient) reuse the same parser; depth and value
 * limits are the same for every caller.
 */
export function parseStrictJson(text: string, limits: StrictJsonLimits = {}): StrictJsonResult {
  const maxBytes = limits.maxBytes ?? MAX_MODEL_JSON_BYTES;
  if (typeof text !== "string") return { ok: false, issue: "invalid_json" };
  // Every UTF-16 unit is ≥ 1 UTF-8 byte: a cheap rejection first, then the exact
  // byte count (Buffer.byteLength counts without allocating a copy).
  if (text.length > maxBytes || Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, issue: "too_large" };
  }
  let i = 0;
  let values = 0;

  const fail = (issue: StrictJsonIssue = "invalid_json"): never => {
    throw new StrictJsonError(issue);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else return;
    }
  };
  const count = () => {
    if (++values > MAX_MODEL_JSON_VALUES) fail("too_large");
  };

  const parseString = (): string => {
    // precondition: text[i] === '"'
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= text.length) fail();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) fail(); // unescaped control character
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(start, i);
      const e = text[i + 1];
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16)); // surrogate pairs combine naturally
          i += 4;
          break;
        }
        default:
          fail();
      }
      i += 2;
      start = i;
    }
  };

  const parseValue = (depth: number): unknown => {
    ws();
    count();
    const c = text[i];
    if (c === "{") {
      if (depth >= MAX_MODEL_JSON_DEPTH) fail("too_deep");
      i++;
      const obj: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = parseString();
        if (seen.has(key)) fail("duplicate_key");
        seen.add(key);
        ws();
        if (text[i] !== ":") fail();
        i++;
        const v = parseValue(depth + 1);
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail();
      }
    }
    if (c === "[") {
      if (depth >= MAX_MODEL_JSON_DEPTH) fail("too_deep");
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail();
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m || m[0].length === 0) fail();
    i += m![0].length;
    const n = Number(m![0]);
    if (!Number.isFinite(n)) fail(); // JSON.parse would give Infinity; never useful here
    return n;
  };

  try {
    const value = parseValue(0);
    ws();
    if (i !== text.length) fail(); // trailing data / a second document
    return { ok: true, value };
  } catch (e) {
    if (e instanceof StrictJsonError) return { ok: false, issue: e.issue };
    return { ok: false, issue: "invalid_json" };
  }
}
