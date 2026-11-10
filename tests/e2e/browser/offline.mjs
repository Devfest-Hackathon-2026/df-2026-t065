/*
 * _notice: SYNTHETIC TEST DATA. Real Chrome + two independent production builds.
 * npm run test:offline-browser (requires an existing npm run build).
 * CHROME_PATH may select an installed Chrome. No Gemini/Firestore calls.
 * Uses the existing standalone layout without public/, just like Dockerfile.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { launchBrowser, Page, killTree, sleep } from "./cdp.mjs";

const env = { ...process.env, GEMINI_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" };
const temporary = await mkdtemp(join(tmpdir(), "allergy-offline-e2e-"));
const children = [];
let browser, proxy;
const report = [];
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const note = (name) => { report.push(name); console.log(`PASS ${name}`); };
const digest = (body) => createHash("sha256").update(body).digest("hex");
const client = ts.transpileModule(await readFile("src/client/serviceWorkerRegistration.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
async function port() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const value = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return value;
}
async function snapshot(name) {
  const directory = join(temporary, name);
  await cp(".next/standalone", directory, { recursive: true });
  await cp(".next/static", join(directory, ".next/static"), { recursive: true });
  const buildId = (await readFile(join(directory, ".next/BUILD_ID"), "utf8")).trim();
  const source = await readFile(join(directory, ".next/static/offline/worker.js"), "utf8");
  const manifest = JSON.parse(source.split("\n")[0].slice("const BUILD_MANIFEST = ".length, -1));
  assert.equal(manifest.buildId, buildId);
  assert.equal(manifest.rootHash, digest(await readFile(join(directory, ".next/server/app/index.html"))));
  const compiledClients = await Promise.all(Object.keys(manifest.assets).filter((p) => p.endsWith(".js"))
    .map((p) => readFile(join(directory, ".next/static", p.slice("/_next/static/".length)), "utf8")));
  assert(compiledClients.some((text) => text.includes(buildId)), "client must embed its own build ID");
  const serverPort = await port();
  const child = spawn(process.execPath, ["server.js"], { cwd: directory, env: { ...env, HOSTNAME: "127.0.0.1", PORT: String(serverPort) }, stdio: "ignore" });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${serverPort}/`)).ok) return { directory, serverPort, buildId, manifest }; } catch { /* starting */ }
    await sleep(100);
  }
  throw Error("Standalone server did not start");
}
function ready(page, build) {
  return page.eval(`(async () => { const exports = {}; const process = { env: { NEXT_PUBLIC_OFFLINE_BUILD_ID: ${JSON.stringify(build.buildId)} } }; ${client}; return exports.isOfflineReady(); })()`);
}
async function sibling(page) {
  const { targetId } = await browser.conn.send("Target.createTarget", { url: "about:blank", browserContextId: page.browserContextId });
  const { sessionId } = await browser.conn.send("Target.attachToTarget", { targetId, flatten: true });
  const result = new Page(browser.conn, sessionId, targetId, page.browserContextId);
  await result.init();
  return result;
}
async function status(page, which = "controller") {
  return page.eval(`(async()=>{const sw=${which === "waiting" ? "(await navigator.serviceWorker.getRegistration()).waiting" : "navigator.serviceWorker.controller"}; if(!sw) return null;return new Promise(r=>{const c=new MessageChannel();c.port1.onmessage=e=>{c.port1.close();r(e.data)};sw.postMessage({type:'GET_PRECACHE_STATUS'},[c.port2])})})()`);
}
try {
  const a = await snapshot("A");
  // Keep all build output, including failures, in the invoking terminal.
  const build = spawn("npm", ["run", "build"], { env, stdio: "inherit" });
  children.push(build);
  assert.equal(await new Promise((resolve) => build.on("exit", resolve)), 0, "second production build");
  const b = await snapshot("B");
  assert.notEqual(a.buildId, b.buildId);
  let current = a;
  let offline = false;
  let forbiddenHeader = "";
  proxy = createServer((incoming, outgoing) => {
    if (offline) { incoming.socket.destroy(); return; }
    if (incoming.url.startsWith("/api/") || incoming.url === "/private.json" || incoming.url === "/photo.jpg") {
      outgoing.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      outgoing.end('{"_notice":"SYNTHETIC TEST DATA"}');
      return;
    }
    const upstream = httpRequest({ hostname: "127.0.0.1", port: current.serverPort, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
      const headers = { ...response.headers };
      if (forbiddenHeader && incoming.url === "/") headers["cache-control"] = forbiddenHeader;
      outgoing.writeHead(response.statusCode, headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  browser = await launchBrowser();
  console.log(`Browser: ${(await browser.conn.send("Browser.getVersion")).product}`);
  const page = await browser.newPage();
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto(base);
  await page.waitFor("!!navigator.serviceWorker.controller", { timeout: 30000, message: "initial SW control" });
  assert(await ready(page, a));
  await page.waitFor(`${page.sel("offline-cache-status") }?.getAttribute('data-ready') === 'true'`);
  note("initial install precaches the actual root and every build asset, without an online reload");
  for (const path of ["/api/private", "/private.json", "/photo.jpg"]) {
    await page.eval(`fetch(${JSON.stringify(path)}).then(r=>r.text())`);
  }
  const cached = await page.eval(`(async()=>{const c=await caches.open('allergy-bridge-build-${a.buildId}');return (await c.keys()).map(r=>new URL(r.url).pathname)})()`);
  assert.deepEqual(new Set(cached), new Set(["/", ...Object.keys(a.manifest.assets)]));
  note("API, private JSON and image URLs never enter Cache Storage");
  await page.click("select-all-allergens-btn");
  offline = true;
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.reload();
  await page.waitForTestId("offline-go-to-card-btn");
  await page.click("offline-go-to-card-btn");
  await page.waitForTestId("phrase-card-Q_ALLERGEN_EGG");
  assert.equal(await page.eval(`document.querySelectorAll('[data-testid^="phrase-card-Q_ALLERGEN_"]').length`), 11);
  await page.click("staff-answer-btn-ANS_CONTAINS");
  assert.equal(await page.eval(`${page.sel("staff-answer-btn-ANS_CONTAINS")}.getAttribute('aria-pressed')`), "true");
  await page.click("card-back-to-settings-btn");
  await page.click("user-lang-btn-en");
  await page.click("offline-go-to-card-btn");
  await page.waitFor(`document.documentElement.innerText.includes('Working Offline')`);
  assert(!page.consoleErrors.some((text) => text.includes("#418")), "no hydration mismatch");
  note("offline reload, 11 cards, Japanese/English switch and staff answer interaction");

  const paths = Object.keys(a.manifest.assets);
  await page.eval(`(async()=>{const c=await caches.open('allergy-bridge-build-${a.buildId}');for(const r of await c.keys())if(new URL(r.url).pathname!=='/' && new URL(r.url).pathname!==${JSON.stringify(paths[0])})await c.delete(r)})()`);
  assert.equal(await ready(page, a), false);
  note("real generated HTML plus only one asset is NOT ready");
  offline = false;
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  for (const path of paths) await page.eval(`fetch(${JSON.stringify(path)}).then(r=>r.arrayBuffer())`);
  await page.waitFor(`caches.open('allergy-bridge-build-${a.buildId}').then(c=>c.keys()).then(k=>k.length===${paths.length + 1})`);
  assert(await ready(page, a));
  note("online network fetch repairs missing assets within the same build");

  const appA = Object.keys(a.manifest.assets).find((path) => path.endsWith(".js") && !Object.hasOwn(b.manifest.assets, path));
  const appB = Object.keys(b.manifest.assets).find((path) => path.endsWith(".js") && !Object.hasOwn(a.manifest.assets, path));
  assert(appA && appB, "independent builds must contain different client chunks");
  const newerBytes = await readFile(join(b.directory, ".next/static", appB.slice("/_next/static/".length)), "utf8");
  await page.eval(`caches.open('allergy-bridge-build-${a.buildId}').then(c=>c.put(${JSON.stringify(appA)},new Response(${JSON.stringify(newerBytes)})))`);
  assert.equal(await ready(page, a), false);
  await page.eval(`fetch(${JSON.stringify(appA)}).then(r=>r.arrayBuffer())`);
  assert(await ready(page, a));
  note("a real newer-build chunk injected under an old URL is rejected and repaired");

  // New worker + old/wrong HTML: installation must fail before activation.
  current = b;
  for (const header of ["private", "no-store"]) {
    forbiddenHeader = header;
    await page.eval("navigator.serviceWorker.getRegistration().then(r=>r.update())");
    await page.waitFor(`navigator.serviceWorker.getRegistration().then(r=>!r.installing && !r.waiting)`, { timeout: 30000 });
    assert.equal((await status(page)).version, a.buildId);
    assert(await ready(page, a));
    note(`${header} root rejected during new-build install; old complete build preserved`);
  }
  forbiddenHeader = "";
  await page.eval("navigator.serviceWorker.getRegistration().then(r=>r.update())");
  await page.waitFor("navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)", { timeout: 30000 });
  assert.equal((await status(page)).version, a.buildId);
  assert.equal((await status(page, "waiting")).version, b.buildId);
  assert.equal((await status(page, "waiting")).complete, true);
  assert(await page.eval(`caches.has('allergy-bridge-build-${a.buildId}')`));
  note("complete new generation waits; old tab retains old controller and assets");

  const newer = await sibling(page);
  await newer.send("Network.setCacheDisabled", { cacheDisabled: true });
  await newer.goto(base);
  await newer.waitForTestId("settings-section");
  assert.equal(await ready(newer, b), false, "new HTML on old controller must not report ready");
  const oldRootHash = await page.eval(`(async()=>{const r=await (await caches.open('allergy-bridge-build-${a.buildId}')).match('/');const h=await crypto.subtle.digest('SHA-256',await r.arrayBuffer());return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')})()`);
  assert.equal(oldRootHash, a.manifest.rootHash);
  note("new HTML cannot overwrite old cached root, and cross-build readiness is rejected");
  const contextId = page.browserContextId;
  await browser.conn.send("Target.closeTarget", { targetId: page.targetId });
  await browser.conn.send("Target.closeTarget", { targetId: newer.targetId });
  await sleep(500);
  // Reuse storage after closing all old windows; normal lifecycle activates B.
  const { targetId } = await browser.conn.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
  const { sessionId } = await browser.conn.send("Target.attachToTarget", { targetId, flatten: true });
  const final = new Page(browser.conn, sessionId, targetId, contextId);
  await final.init();
  await final.send("Network.setCacheDisabled", { cacheDisabled: true });
  await final.goto(base);
  await final.waitFor("!!navigator.serviceWorker.controller");
  assert(await ready(final, b));
  await final.waitFor(`${final.sel("offline-cache-status") }?.getAttribute('data-ready') === 'true'`);
  offline = true;
  await final.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await final.reload();
  await final.waitForTestId("settings-section");
  await final.click("select-all-allergens-btn");
  await final.waitForTestId("offline-go-to-card-btn");
  await final.click("offline-go-to-card-btn");
  await final.waitForTestId("phrase-card-Q_ALLERGEN_EGG");
  note("new generation activates after old tabs close and independently boots offline");
  await final.close();
  const result = { buildA: a.buildId, buildB: b.buildId, passed: report };
  if (reportPath) await writeFile(reportPath, JSON.stringify(result, null, 2));
  console.log(`${report.length} scenarios passed. ${JSON.stringify(result)}`);
} finally {
  await browser?.close();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  for (const child of children) killTree(child);
  // Test build copies and server files contain only synthetic/static artifacts.
  await rm(temporary, { recursive: true, force: true });
}
