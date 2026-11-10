import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (body) => createHash("sha256").update(body).digest("hex");
const buildId = (await readFile(".next/BUILD_ID", "utf8")).trim();
const html = await readFile(".next/server/app/index.html");
const assets = {};
async function collect(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (relative === "" && entry.name === "offline") continue;
    const path = join(directory, entry.name);
    const name = `${relative}${entry.name}`;
    if (entry.isDirectory()) await collect(path, `${name}/`);
    else if (/\.(?:js|css|woff2?|ttf|otf)$/.test(name)) {
      assets[`/_next/static/${name}`] = digest(await readFile(path));
    }
  }
}
await collect(".next/static");
// Reject a build whose actual HTML references assets outside the inventory.
const referenced = [...html.toString().matchAll(/(?:src|href)="(\/_next\/static\/[^"?#]+)"/g)]
  .map((match) => match[1].replaceAll("&amp;", "&"));
if (!referenced.some((path) => path.endsWith(".js")) || referenced.some((path) => !assets[path])) {
  throw new Error("Incomplete root HTML asset inventory");
}
const manifest = { buildId, rootHash: digest(html), assets };
const template = await readFile("public/sw.js", "utf8");
await mkdir(".next/static/offline", { recursive: true });
await writeFile(".next/static/offline/worker.js", `const BUILD_MANIFEST = ${JSON.stringify(manifest)};\n${template}`);
console.log(`Offline worker: build ${buildId}, ${Object.keys(assets).length} verified assets`);
