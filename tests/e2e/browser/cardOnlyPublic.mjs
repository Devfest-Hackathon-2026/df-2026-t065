/* Production, local-only browser smoke. SYNTHETIC TEST DATA; no cloud calls.
 * npm run build && node tests/e2e/browser/cardOnlyPublic.mjs
 * With PR #27 integrated: node tests/e2e/browser/cardOnlyPublic.mjs --expect-service-worker
 * Cloud Run IAM/Ingress and real public access still require separate approval and testing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { killTree, launchBrowser, sleep } from "./cdp.mjs";

const requireServiceWorker = process.argv.includes("--expect-service-worker");
const imageControls = ["analyze-menu-btn", "camera-capture-btn", "file-picker-btn", "camera-file-input", "upload-file-input"];
async function assertImageControlsDisabled(page) {
  for (const id of imageControls) assert(await page.isDisabled(id), `${id} must be disabled`);
}
async function forceUnavailableActions(page) {
  await page.eval(`(() => {
    const button = document.querySelector('[data-testid="analyze-menu-btn"]');
    button.disabled = false;
    button.click();
    const input = document.querySelector('[data-testid="upload-file-input"]');
    input.disabled = false;
    const transfer = new DataTransfer();
    transfer.items.add(new File(['SYNTHETIC TEST DATA'], 'synthetic.png', {type: 'image/png'}));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await sleep(100);
  assert.equal(page.apiRequests.length, 0, "disabled UI sent an image API request");
}
async function waitForOfflineReady(page) {
  await page.waitFor("!!navigator.serviceWorker.controller", { timeout: 30000 });
  await page.waitFor(`${page.sel("offline-cache-status")}.dataset.ready === 'true'`, { timeout: 30000 });
}

const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  env: { ...process.env, NODE_ENV: "production", GEMINI_ENABLED: "false", MOCK_GEMINI: "true", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore", detached: true,
});
let browser;
try {
  let online = false;
  for (let i = 0; i < 100; i++) {
    try { online = (await fetch(url)).ok; } catch { /* starting */ }
    if (online) break;
    await sleep(100);
  }
  assert(online, "production server did not start");
  assert.match(await (await fetch(url)).text(), /card-only-notice/, "SSR must declare card_only before hydration");
  const worker = await fetch(`${url}/offline-worker`, { credentials: "omit" });
  const hasServiceWorker = worker.status === 200 && /javascript/.test(worker.headers.get("content-type") || "");
  if (requireServiceWorker) assert(hasServiceWorker, "--expect-service-worker requires a generated production worker");
  if (!hasServiceWorker) assert.equal(worker.status, 404, "an unavailable or broken integrated worker must not silently skip offline checks");
  for (const body of ["malformed", "x".repeat(5 * 1024 * 1024)]) {
    const res = await fetch(`${url}/api/analyze-menu`, {
      method: "POST", credentials: "omit", body,
      headers: { "content-type": "application/octet-stream", "x-mock-scenario": "ok" },
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await res.json()).error.code, "AI_DISABLED");
  }
  browser = await launchBrowser();
  for (const mobile of [false, true]) {
    const page = await browser.newPage(); // Fresh browser context, no cookies or saved settings.
    try {
      if (mobile) await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.send("Network.setCacheDisabled", { cacheDisabled: true });
      await page.goto(url);
      await page.waitForTestId("card-only-notice");
      if (hasServiceWorker) await waitForOfflineReady(page);
      await page.waitFor(`${page.sel("settings-interaction-gate")}.dataset.ready === 'true' && !${page.sel("settings-interaction-gate")}.disabled`);
      assert.match(await page.bodyText(), /画像解析は現在利用できません/);
      await page.click("allergen-option-egg");
      await page.waitFor(`!${page.sel("proceed-to-upload-btn")}.disabled`);
      await page.click("proceed-to-upload-btn");
      await page.waitForTestId("analyze-menu-btn");
      await assertImageControlsDisabled(page);
      await page.click("analyze-menu-btn");
      // Bypass the DOM disabled flag: handlers must still reject stale/forced events.
      await forceUnavailableActions(page);
      assert.equal(await page.isDisabled("upload-to-card-btn"), false);
      await page.click("upload-to-card-btn");
      await page.waitForTestId("confirm-card-placeholder-section");
      await page.click("step-nav-settings");
      await page.waitForTestId("user-lang-btn-en");
      await page.click("user-lang-btn-en");
      await page.waitFor(`document.body.innerText.includes('Image analysis is currently unavailable')`);
      assert.equal(page.apiRequests.length, 0);
      assert.equal(page.requestedUrls.some(u => /googleapis\.com|accounts\.google\.com/.test(u)), false);
      if (hasServiceWorker) {
        await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await page.reload();
        await page.waitForTestId("card-only-notice");
        await waitForOfflineReady(page);
        await page.waitFor(`${page.sel("settings-interaction-gate")}.dataset.ready === 'true' && !${page.sel("settings-interaction-gate")}.disabled`);
        await page.click("select-all-allergens-btn");
        await page.click("proceed-to-upload-btn");
        await page.waitForTestId("analyze-menu-btn");
        await assertImageControlsDisabled(page);
        await forceUnavailableActions(page);
        await page.click("upload-to-card-btn");
        await page.waitForTestId("phrase-card-Q_ALLERGEN_EGG");
        assert.equal(await page.eval(`document.querySelectorAll('[data-testid^="phrase-card-Q_ALLERGEN_"]').length`), 11);
        await page.click("staff-answer-btn-ANS_CONTAINS");
        assert.equal(await page.eval(`${page.sel("staff-answer-btn-ANS_CONTAINS")}.getAttribute('aria-pressed')`), "true");
        await page.click("card-back-to-settings-btn");
        await page.click("user-lang-btn-ja");
        await page.click("offline-go-to-card-btn");
        await page.waitFor(`document.body.innerText.includes('オフラインで利用中')`);
        await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await page.waitFor(`!${page.sel("offline-status-banner")}`);
        assert.equal(page.apiRequests.length, 0, "reconnection must not automatically analyze");
        assert.equal(page.requestedUrls.some(u => /googleapis\.com|accounts\.google\.com/.test(u)), false);
        console.log(`PASS: ${mobile ? "mobile viewport" : "desktop"} SW-controlled card_only, HTTP-cache-disabled offline reload, forced API=0, 11 cards, answers, Japanese/English and reconnection`);
      }
      assert.equal(page.consoleErrors.length, 0, page.consoleErrors.join("\n"));
      console.log(`PASS: ${mobile ? "mobile viewport" : "desktop"} initial state, disabled controls, cards and language`);
    } finally { await page.close(); }
  }
  if (!hasServiceWorker) console.log("UNVERIFIED: offline reload (standalone card_only build without PR #27); integrate PR #27 and rerun with --expect-service-worker");
  console.log("PASS: local unauthenticated invalid/5MiB API=503 no-store; production Mock not exposed");
} finally {
  if (browser) await browser.close();
  killTree(server);
}
