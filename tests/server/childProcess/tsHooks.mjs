import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as r } from "node:path";
// TEST ONLY: lets a PLAIN Node child process (no Vitest, Node's default
// unhandled-rejection behaviour) run TypeScript test scenarios with Node's
// built-in type transform: maps "@/…" to src/ and resolves extensionless
// relative imports to .ts files; JSON imports get the required attribute.
const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));
export async function resolve(spec, ctx, next) {
  let s = spec;
  if (s.startsWith("@/")) s = pathToFileURL(SRC + s.slice(2)).href;
  else if ((s.startsWith("./") || s.startsWith("../")) && ctx.parentURL?.startsWith("file:")) s = pathToFileURL(r(dirname(fileURLToPath(ctx.parentURL)), s)).href;
  if (s.startsWith("file:") && !/\.[cm]?[jt]s$/.test(s)) {
    const p = fileURLToPath(s);
    for (const c of [p + ".ts", p + "/index.ts"]) if (existsSync(c)) return next(pathToFileURL(c).href, ctx);
  }
  return next(s, ctx);
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  return next(url, ctx);
}
