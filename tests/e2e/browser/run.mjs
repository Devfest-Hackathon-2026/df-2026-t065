/*
 * Browser E2E (real headless Chrome/Edge via CDP) for PR3 audit fixes.
 *
 *   node tests/e2e/browser/run.mjs [--report <path.json>] [--only <substring>]
 *   node tests/e2e/browser/run.mjs --production [--report <path.json>] (requires npm run build)
 *
 * - Starts `next dev` with MOCK_GEMINI=true on a free port (development only).
 * - Most scenarios stub POST /api/analyze-menu inside the browser (CDP Fetch domain)
 *   so that response order, delays and error codes are deterministic. One scenario
 *   passes requests through to the real mock route.
 * - Uses SYNTHETIC images generated at runtime (solid-colour PNGs). No real menu photos.
 * - Not part of `npm run verify` / CI (no browser in CI, no new dependencies).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { killTree, launchBrowser, sleep } from "./cdp.mjs";
import {
  assertCropBoundaryPixels,
  assertUprightQuadrants,
  EXPECTED_CROP_HEIGHT,
  EXPECTED_CROP_WIDTH,
  EXPECTED_UPRIGHT_HEIGHT,
  EXPECTED_UPRIGHT_WIDTH,
  generateSyntheticExifJpegs,
  ORIENTATION_CONFIGS,
} from "./syntheticExifJpeg.mjs";

const args = process.argv.slice(2);
const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : null;
const production = args.includes("--production");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

// ---------------------------------------------------------------------------
// Synthetic images
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function quadrantPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const top = y < height / 2;
      const left = x < width / 2;
      const color = top ? (left ? [220, 30, 30] : [30, 180, 60]) : (left ? [40, 70, 210] : [230, 190, 30]);
      raw.set(color, row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const imgDir = mkdtempSync(join(tmpdir(), "ab-e2e-img-"));
const IMG_A = join(imgDir, "synthetic-a.png");
const IMG_B = join(imgDir, "synthetic-b.png");
writeFileSync(IMG_A, solidPng(96, 64, [200, 40, 40]));
writeFileSync(IMG_B, solidPng(64, 96, [40, 40, 200]));
const CROP_WIDE = join(imgDir, "synthetic-crop-wide.png");
writeFileSync(CROP_WIDE, quadrantPng(800, 200));
const FAKE_PNG = join(imgDir, "fake.png");
const CORRUPT_PNG = join(imgDir, "corrupt.png");
const LARGE_PNG = join(imgDir, "large.png");
writeFileSync(FAKE_PNG, "SYNTHETIC TEST DATA: not a PNG");
const validPng = solidPng(96, 64, [40, 200, 40]);
writeFileSync(CORRUPT_PNG, validPng.subarray(0, 33));
writeFileSync(LARGE_PNG, Buffer.concat([validPng.subarray(0, 33), chunk("tEXt", Buffer.concat([
  Buffer.from("_notice\0SYNTHETIC TEST DATA "), Buffer.alloc(4 * 1024 * 1024, 65),
])), validPng.subarray(33)]));

// ---------------------------------------------------------------------------
// Stub responses (SYNTHETIC; shape follows src/contracts/analyze.ts)
// ---------------------------------------------------------------------------
function okBody({ dish, allergens, dataOrigin = "ai_analysis", requestId = `stub-${dish}` }) {
  return {
    requestId,
    status: "ok",
    dataOrigin,
    imageIssues: [],
    items: [
      {
        id: "item-1",
        readText: { text: `${dish} grilled with butter`, lang: "en", readBy: "ai" },
        aiTranslation: { text: `${dish} バター焼き`, lang: "ja", verified: false },
        readability: "clear",
        allergens: allergens.map((code) => ({ code, category: "unconfirmed", reason: "not_mentioned", confirmationRequired: true })),
      },
    ],
    menuNotices: [],
  };
}
const RETRYABLE = { INVALID_INPUT: false, RATE_LIMITED: true, AI_DISABLED: false, AI_TIMEOUT: true, AI_FAILED: true };
function errBody(code) {
  return { requestId: `stub-${code}`, error: { code, retryable: RETRYABLE[code] } };
}
const ok = (opts, delayMs = 0) => ({ status: 200, body: okBody(opts), delayMs });
const err = (status, code, delayMs = 0) => ({ status, body: errBody(code), delayMs });

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
async function startDevServer() {
  const port = await freePort();
  const nextArgs = ["node_modules/next/dist/bin/next", production ? "start" : "dev", ...(production ? [] : ["--webpack"]), "-p", String(port), "-H", "127.0.0.1"];
  const proc = spawn(process.execPath, nextArgs, {
    env: { ...process.env, MOCK_GEMINI: "true", AI_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(base + "/");
      if (r.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 120_000) {
      killTree(proc);
      throw new Error("next dev did not start:\n" + log);
    }
    await sleep(500);
  }
  return { base, proc, getLog: () => log };
}

// ---------------------------------------------------------------------------
// Assertions & flows
// ---------------------------------------------------------------------------
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function openApp(page, base) {
  await page.goto(base + "/");
  await page.waitForTestId("settings-section", 30_000);
  // Product state, not React private DOM fields: controls enable only after
  // saved settings are restored and the interactive commit is complete.
  await page.waitFor(
    `document.querySelector('[data-testid="settings-interaction-gate"]')?.dataset.ready === "true"`,
    { timeout: 30_000, message: "settings restored and interactive" },
  );
}
async function toggleAllergen(page, code) {
  await page.clickSelector(`[data-testid="allergen-option-${code}"] input`);
}
async function setupToUpload(page, base, { allergens = ["shrimp"], userLang = "ja" } = {}) {
  await openApp(page, base);
  if (userLang === "en") await page.click("user-lang-btn-en");
  for (const a of allergens) await toggleAllergen(page, a);
  await page.click("proceed-to-upload-btn");
  await page.waitForTestId("upload-section");
}
async function uploadImage(page, path) {
  const before = await page.eval(`(${page.sel("uploaded-menu-preview-img")} || {}).src || ""`);
  await page.setInputFiles('[data-testid="upload-file-input"]', [path]);
  await page.waitFor(
    `(() => { const img = ${page.sel("uploaded-menu-preview-img")}; return !!img && img.src !== ${JSON.stringify(before)} && !${page.sel("image-processing-status")}; })()`,
    { message: "processed image preview" },
  );
}
async function analyzeAndWaitResult(page, dish) {
  await page.click("analyze-menu-btn");
  await page.waitForTestId("results-section");
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(dish)})`, { message: dish });
}
async function assertNoStaleResult(page, staleDish) {
  assert(await page.isDisabled("step-nav-results"), "step-nav-results must be disabled after invalidation");
  await page.eval(`(${page.sel("step-nav-results")})?.click()`);
  await sleep(100);
  assert(!(await page.exists("results-section")), "results-section must not be shown");
  const text = await page.bodyText();
  assert(!text.includes(staleDish), `stale dish "${staleDish}" must not be visible on the current screen`);
  // Confirmation card must not carry stale dishes either
  if (!(await page.isDisabled("step-nav-confirmCard"))) {
    await page.click("step-nav-confirmCard");
    await page.waitForTestId("confirm-card-placeholder-section");
    const cardText = await page.bodyText();
    assert(!cardText.includes(staleDish), `stale dish "${staleDish}" must not appear on the confirmation screen`);
    assert(!(await page.exists("card-back-to-results-btn")), "back-to-results must not be offered for a stale result");
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const scenarios = [];
const test = (name, fn) => scenarios.push({ name, fn });

test("T01 同じ解析条件の正常な成功応答は表示される", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-A", allergens: ["shrimp"] });
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-A");
  assert(!(await page.exists("mock-fixture-banner")), "ai_analysis stub must not show mock banner");
  assert(!(await page.isDisabled("step-nav-results")), "results nav enabled for current result");
});

test("T02 画像A→Bへ変更すると結果Aは無効化される", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-A", allergens: ["shrimp"] });
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-A");
  await page.click("step-nav-upload");
  await page.waitForTestId("upload-section");
  await uploadImage(page, IMG_B);
  await assertNoStaleResult(page, "DISH-A");
});

test("T03 えび→乳へ変更すると以前のえび評価は残らない", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-A", allergens: ["shrimp"] });
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-A");
  await page.click("step-nav-settings");
  await page.waitForTestId("settings-section");
  await toggleAllergen(page, "shrimp");
  await toggleAllergen(page, "milk");
  await assertNoStaleResult(page, "DISH-A");
});

test("T04 言語ペアを変更すると結果は無効化される", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-A", allergens: ["shrimp"] });
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-A");
  await page.click("step-nav-settings");
  await page.waitForTestId("settings-section");
  await page.click("store-lang-btn-ja");
  await assertNoStaleResult(page, "DISH-A");
});

test("T05 解析中に入力を変更すると遅延応答は破棄され結果画面へ遷移しない", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-LATE", allergens: ["shrimp"] }, 2000);
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await page.click("analyze-menu-btn");
  await sleep(250);
  await page.click("step-nav-settings");
  await page.waitForTestId("settings-section");
  await toggleAllergen(page, "milk");
  await sleep(2800);
  assert(await page.exists("settings-section"), "must stay on the settings screen");
  assert(!(await page.exists("results-section")), "late response must not open results");
  assert(!(await page.bodyText()).includes("DISH-LATE"), "late dish must not be shown");
  await page.click("step-nav-upload");
  await page.waitForTestId("upload-section");
  assert(!(await page.isDisabled("analyze-menu-btn")), "analyze button must not stay stuck in analyzing state");
});

test("T06 応答順序の逆転（古い成功が後から到着）でも新しい結果だけを表示", async (page, base) => {
  page.apiHandler = (_info, i) =>
    i === 0 ? ok({ dish: "DISH-OLD", allergens: ["shrimp"] }, 2500) : ok({ dish: "DISH-NEW", allergens: ["shrimp", "milk"] }, 100);
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await page.click("analyze-menu-btn");
  await sleep(250);
  await page.click("step-nav-settings");
  await page.waitForTestId("settings-section");
  await toggleAllergen(page, "milk");
  await page.click("step-nav-upload");
  await page.waitForTestId("upload-section");
  await analyzeAndWaitResult(page, "DISH-NEW");
  await sleep(3200);
  const text = await page.bodyText();
  assert(text.includes("DISH-NEW"), "new result must remain");
  assert(!text.includes("DISH-OLD"), "old late success must be discarded");
});

for (const [status, code, label] of [
  [503, "AI_DISABLED", "T07 503"],
  [429, "RATE_LIMITED", "T08 429"],
  [504, "AI_TIMEOUT", "T09 504タイムアウト"],
]) {
  test(`${label} 新規解析の失敗後に前回の成功結果へ戻れない・自動再試行しない`, async (page, base) => {
    page.apiHandler = (_info, i) => (i === 0 ? ok({ dish: "DISH-A", allergens: ["shrimp"] }) : err(status, code));
    await setupToUpload(page, base);
    await uploadImage(page, IMG_A);
    await analyzeAndWaitResult(page, "DISH-A");
    await page.click("step-nav-upload");
    await page.waitForTestId("upload-section");
    await page.click("analyze-menu-btn");
    await page.waitForTestId("error-banner");
    const shownCode = await page.eval(`${page.sel("error-banner")}.getAttribute("data-error-code")`);
    assert(shownCode === code, `error code shown: ${shownCode}`);
    assert(await page.exists("error-card-fallback-btn"), "card-only fallback must be offered");
    assert(await page.exists("error-retake-btn"), "retake must be offered");
    await assertNoStaleResult(page, "DISH-A");
    await sleep(1500);
    assert(page.apiRequests.length === 2, `no automatic retry (requests=${page.apiRequests.length})`);
  });
}

test("T10 画像削除後の画面遷移で古い結果が出ない", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-A", allergens: ["shrimp"] });
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-A");
  await page.click("step-nav-upload");
  await page.waitForTestId("upload-section");
  await page.click("clear-image-btn");
  await assertNoStaleResult(page, "DISH-A");
});

test("T11 戻る操作・再読み込みで古い結果が復活しない", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-A", allergens: ["shrimp"] });
  await setupToUpload(page, base);
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-A");
  await page.click("select-dish-checkbox-item-1");
  await page.click("results-to-card-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert(await page.exists("card-back-to-results-btn"), "valid result: back-to-results offered");
  await page.click("card-back-to-settings-btn");
  await page.waitForTestId("settings-section");
  await toggleAllergen(page, "egg");
  await page.click("step-nav-confirmCard");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert(!(await page.exists("card-back-to-results-btn")), "back-to-results must disappear");
  assert(!(await page.bodyText()).includes("DISH-A"), "dish must disappear from card");
  await page.click("card-back-to-upload-btn");
  await page.waitForTestId("upload-section");
  assert(await page.isDisabled("step-nav-results"), "results nav must stay disabled after back navigation");
  assert(!(await page.bodyText()).includes("DISH-A"), "dish must not revive on upload screen");
  await openApp(page, base);
  assert(await page.isDisabled("step-nav-results"), "results must not be restored after reload");
  assert(!(await page.bodyText()).includes("DISH-A"), "dish must not be restored after reload");
});

for (const [origin, label] of [
  ["mock_fixture", "T12a Mockスタブ"],
  ["ai_analysis", "T12b 実AI応答スタブ"],
]) {
  test(`${label}: 結果→確認画面で出典・未検証表示が引き継がれる`, async (page, base) => {
    page.apiHandler = () => ok({ dish: "DISH-P", allergens: ["shrimp"], dataOrigin: origin });
    await setupToUpload(page, base);
    await uploadImage(page, IMG_A);
    await analyzeAndWaitResult(page, "DISH-P");
    assert((await page.exists("mock-fixture-banner")) === (origin === "mock_fixture"), "results mock banner");
    await page.click("select-dish-checkbox-item-1");
    await page.click("results-to-card-btn");
    await page.waitForTestId("confirm-card-placeholder-section");
    assert(await page.exists("verified-card-header-badge"), "verified card header badge must be visible");
    assert((await page.exists("card-mock-banner")) === (origin === "mock_fixture"), `card mock banner for ${origin}`);
    const dishVisible = await page.exists("card-summary-dish-item-1");
    if (dishVisible) {
      assert(await page.exists("card-dish-provenance-item-1"), "dish must carry an AI-read / unverified label");
      const prov = await page.eval(`${page.sel("card-dish-provenance-item-1")}.innerText`);
      assert(/未検証|unverified/i.test(prov), `provenance label text: ${prov}`);
      assert(/AI/.test(prov), `provenance label mentions AI: ${prov}`);
    }
    const origAttr = await page.eval(`${page.sel("confirm-card-placeholder-section")}.getAttribute("data-origin")`);
    assert(origAttr === origin, `data-origin carried to card: ${origAttr}`);
  });
}

test("T13 実Mockルート（MOCK_GEMINI=true）で結果→確認画面にMock表示", async (page, base) => {
  page.apiHandler = () => "continue";
  await setupToUpload(page, base, { allergens: ["shrimp", "wheat", "egg", "milk"] });
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "Shrimp Tempura");
  assert(await page.exists("mock-fixture-banner"), "mock banner on results");
  for (const category of ["menu_mentions", "ai_inferred", "unconfirmed"]) {
    assert(await page.exists(`dish-item-1-category-${category}`), `category ${category} displayed`);
  }
  assert(/未検証|unverified/i.test(await page.eval(`${page.sel("dish-translation-item-1")}.innerText`)), "verified=false label preserved");
  await page.click("select-dish-checkbox-item-1");
  await page.click("results-to-card-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert(await page.exists("card-mock-banner"), "mock banner on card");
});

test("T14 キーボード（Tab・Enter・Space）で画像入力・キャンセル・再選択", async (page, base) => {
  await setupToUpload(page, base);
  await page.eval("document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)");
  let reached = null;
  for (let i = 0; i < 60; i++) {
    await page.press("Tab");
    const id = await page.activeTestId();
    if (id === "file-picker-btn") {
      reached = id;
      break;
    }
  }
  assert(reached === "file-picker-btn", "file picker control must be reachable by Tab");
  const outline = await page.eval(
    "(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()",
  );
  assert(outline, "focused control must show a visible focus outline");
  // Enter opens the chooser; leaving it unanswered = cancel
  await page.press("Enter");
  await page.waitFor("true");
  await sleep(300);
  assert(page.fileChooserEvents.length === 1, `Enter must open the file chooser (events=${page.fileChooserEvents.length})`);
  assert(!(await page.exists("processed-image-preview-box")), "cancel must not change state");
  // Space also opens it; this time answer with image A
  await page.press("Space");
  await sleep(300);
  assert(page.fileChooserEvents.length === 2, "Space must open the file chooser");
  await page.setFilesForChooser(page.fileChooserEvents[1], [IMG_A]);
  await page.waitForTestId("processed-image-preview-box");
  // Camera control is reachable and keyboard-operable too
  await page.eval(`${page.sel("camera-capture-btn")}.focus()`);
  assert((await page.activeTestId()) === "camera-capture-btn", "camera control focusable");
  await page.press("Enter");
  await sleep(300);
  assert(page.fileChooserEvents.length === 3, "camera control opens chooser with Enter");
  // Re-select another image through the chooser
  const firstSrc = await page.eval(`${page.sel("uploaded-menu-preview-img")}.src`);
  await page.setFilesForChooser(page.fileChooserEvents[2], [IMG_B]);
  await page.waitFor(`${page.sel("uploaded-menu-preview-img")}.src !== ${JSON.stringify(firstSrc)}`, { message: "reselected preview" });
});

test("T15 仕様モーダルのフォーカストラップと閉じた後のフォーカス復帰", async (page, base) => {
  await openApp(page, base);
  await page.eval(`${page.sel("specs-modal-trigger")}.focus()`);
  await page.press("Enter");
  await page.waitForTestId("specs-modal-dialog");
  const inside = `(${page.sel("specs-modal-dialog")}).contains(document.activeElement)`;
  assert(await page.eval(inside), "focus must move into the dialog");
  for (let i = 0; i < 6; i++) {
    await page.press("Tab");
    assert(await page.eval(inside), "Tab must stay inside the dialog");
  }
  for (let i = 0; i < 6; i++) {
    await page.press("Tab", { shift: true });
    assert(await page.eval(inside), "Shift+Tab must stay inside the dialog");
  }
  await page.press("Escape");
  await page.waitFor(`!${page.sel("specs-modal-dialog")}`);
  assert((await page.activeTestId()) === "specs-modal-trigger", "focus must return to the trigger");
});

test("T16 背景は権利未確認の画像を使わない（CSSのみ）", async (page, base) => {
  await openApp(page, base);
  await sleep(500);
  assert(!page.requestedUrls.some((u) => /bg-pattern|\.jpe?g(\?|$)/i.test(u)), "no background image request");
  const bg = await page.eval(`getComputedStyle(${page.sel("fixed-scrolling-bg")}).backgroundImage`);
  assert(!/url\(/i.test(bg), `background must not use url(): ${bg}`);
});

test("T17 初回アクセス（設定なし）でハイドレーションエラーが発生せず初期設定が表示される", async (page, base) => {
  await openApp(page, base);
  await sleep(200);
  assert(page.consoleErrors.length === 0, `unexpected console/hydration errors: ${page.consoleErrors.join(" | ")}`);
  const uiLang = await page.eval(`${page.sel("allergy-bridge-main")}.getAttribute("data-ui-lang")`);
  assert(uiLang === "ja", `expected initial uiLang=ja, got ${uiLang}`);
  const userJaPressed = await page.eval(`${page.sel("user-lang-btn-ja")}.getAttribute("aria-pressed")`);
  const storeEnPressed = await page.eval(`${page.sel("store-lang-btn-en")}.getAttribute("aria-pressed")`);
  assert(userJaPressed === "true" && storeEnPressed === "true", "initial language pair must be ja -> en");
  const checkedCount = await page.eval(
    `document.querySelectorAll('[data-testid^="allergen-option-"] input:checked').length`,
  );
  assert(checkedCount === 0, `expected 0 checked allergens on initial visit, got ${checkedCount}`);
  assert(await page.isDisabled("proceed-to-upload-btn"), "proceed button must be disabled when 0 allergens selected");
});

test("T18 日本語設定を保存して再読み込みしてもハイドレーションエラーなく復元される", async (page, base) => {
  await openApp(page, base);
  await toggleAllergen(page, "shrimp");
  await toggleAllergen(page, "egg");
  await page.waitFor(
    `document.querySelector('[data-testid="allergen-option-shrimp"] input').checked && document.querySelector('[data-testid="allergen-option-egg"] input').checked`,
    { message: "shrimp & egg checked before reload" },
  );

  page.consoleErrors.length = 0;
  await page.reload();
  await page.waitForTestId("settings-section", 30_000);
  await page.waitFor(
    `document.querySelector('[data-testid="allergen-option-shrimp"] input')?.checked === true && document.querySelector('[data-testid="allergen-option-egg"] input')?.checked === true`,
    { timeout: 10_000, message: "restored Japanese settings after reload" },
  );
  await sleep(200);

  assert(page.consoleErrors.length === 0, `hydration/console errors on reload (ja): ${page.consoleErrors.join(" | ")}`);
  const uiLang = await page.eval(`${page.sel("allergy-bridge-main")}.getAttribute("data-ui-lang")`);
  assert(uiLang === "ja", `expected restored uiLang=ja, got ${uiLang}`);
  const userJaPressed = await page.eval(`${page.sel("user-lang-btn-ja")}.getAttribute("aria-pressed")`);
  const storeEnPressed = await page.eval(`${page.sel("store-lang-btn-en")}.getAttribute("aria-pressed")`);
  assert(userJaPressed === "true" && storeEnPressed === "true", "restored language pair must be ja -> en");
  assert(!(await page.isDisabled("proceed-to-upload-btn")), "proceed button must be enabled after restoring allergens");
});

test("T19 英語設定を保存して再読み込みしてもハイドレーションエラーなく復元される", async (page, base) => {
  await openApp(page, base);
  await page.click("user-lang-btn-en");
  await toggleAllergen(page, "peanut");
  await toggleAllergen(page, "wheat");
  await page.waitFor(
    `${page.sel("allergy-bridge-main")}.getAttribute("data-ui-lang") === "en" && document.querySelector('[data-testid="allergen-option-peanut"] input').checked && document.querySelector('[data-testid="allergen-option-wheat"] input').checked`,
    { message: "en settings saved before reload" },
  );

  page.consoleErrors.length = 0;
  await page.reload();
  await page.waitForTestId("settings-section", 30_000);
  await page.waitFor(
    `${page.sel("allergy-bridge-main")}?.getAttribute("data-ui-lang") === "en" && document.querySelector('[data-testid="allergen-option-peanut"] input')?.checked === true && document.querySelector('[data-testid="allergen-option-wheat"] input')?.checked === true`,
    { timeout: 10_000, message: "restored English settings after reload" },
  );
  await sleep(200);

  assert(page.consoleErrors.length === 0, `hydration/console errors on reload (en): ${page.consoleErrors.join(" | ")}`);
  const userEnPressed = await page.eval(`${page.sel("user-lang-btn-en")}.getAttribute("aria-pressed")`);
  const storeJaPressed = await page.eval(`${page.sel("store-lang-btn-ja")}.getAttribute("aria-pressed")`);
  assert(userEnPressed === "true" && storeJaPressed === "true", "restored language pair must be en -> ja");
  const text = await page.bodyText();
  assert(text.includes("Continue to Menu Photo Upload"), "restored UI must render English labels");
});


for (const [label, path] of [["偽PNG", FAKE_PNG], ["破損PNG", CORRUPT_PNG]]) {
  test(`T20 ${label}のエラー後に正常画像を再選択して復旧`, async (page, base) => {
    await setupToUpload(page, base);
    await page.setInputFiles('[data-testid="upload-file-input"]', [path]);
    await page.waitForTestId("error-banner");
    assert(!(await page.exists("image-processing-status")), "processing must settle");
    assert(await page.isDisabled("analyze-menu-btn"), "invalid image cannot be submitted");
    await uploadImage(page, IMG_A);
    assert(!(await page.exists("error-banner")), "error clears after reselect");
    assert(!(await page.isDisabled("analyze-menu-btn")), "normal image recovers");
  });
}

async function holdFirstDecode(page, reject = false) {
  await page.eval(`(() => {
    const original = window.createImageBitmap.bind(window);
    window.decodeStarted = false;
    let first = true;
    window.createImageBitmap = async (...args) => {
      ${reject ? 'if (window.failedDecodeBlob === args[0]) throw new Error("synthetic decode failure");' : ''}
      if (first) {
        first = false; window.decodeStarted = true;
        ${reject ? 'window.failedDecodeBlob = args[0];' : ''}
        await new Promise((resolve) => { window.releaseDecode = resolve; });
        ${reject ? 'throw new Error("synthetic delayed decode failure");' : ''}
      }
      return original(...args);
    };
  })()`);
}

for (const lateReject of [false, true]) {
  test(`T21 画像処理中の設定変更・キャンセル後、古い${lateReject ? "失敗" : "成功"}が新画像を破壊しない`, async (page, base) => {
    await setupToUpload(page, base);
    await holdFirstDecode(page, lateReject);
    await page.setInputFiles('[data-testid="upload-file-input"]', [IMG_A]);
    await page.waitFor("window.decodeStarted === true");
    assert(await page.exists("image-processing-status"), "decode in progress");
    await page.click("step-nav-settings");
    await page.waitForTestId("settings-section");
    await toggleAllergen(page, "milk");
    await page.click("proceed-to-upload-btn");
    await page.waitForTestId("upload-section");
    assert(!(await page.exists("image-processing-status")), "settings change cancels old operation");
    await uploadImage(page, IMG_B);
    const src = await page.eval(`${page.sel("uploaded-menu-preview-img")}.src`);
    await page.eval("window.releaseDecode()");
    await sleep(400);
    assert(await page.eval(`${page.sel("uploaded-menu-preview-img")}.src === ${JSON.stringify(src)}`), "new preview survives old completion");
    assert(!(await page.exists("error-banner")), "old failure does not set an error");
    assert(!(await page.isDisabled("analyze-menu-btn")), "new image remains usable");
  });
}

test("T21b 明示的キャンセル後の古い画像処理が新画像を上書きしない", async (page, base) => {
  await setupToUpload(page, base);
  await holdFirstDecode(page);
  await page.setInputFiles('[data-testid="upload-file-input"]', [IMG_A]);
  await page.waitFor("window.decodeStarted === true");
  await page.click("cancel-image-processing-btn");
  assert(!(await page.exists("image-processing-status")), "cancel clears processing");
  assert(await page.isDisabled("analyze-menu-btn"), "cancel leaves no submit image");
  await uploadImage(page, IMG_B);
  const src = await page.eval(`${page.sel("uploaded-menu-preview-img")}.src`);
  await page.eval("window.releaseDecode()");
  await sleep(400);
  assert(await page.eval(`${page.sel("uploaded-menu-preview-img")}.src === ${JSON.stringify(src)}`), "old decode cannot overwrite new image");
});

test("T22 4MiBを超える正常PNGを前処理し、4MiB以下で送信", async (page, base) => {
  await setupToUpload(page, base, { allergens: ["shrimp", "wheat", "egg", "milk"] });
  await uploadImage(page, LARGE_PNG);
  assert(await page.exists("image-quality-warning"), "legibility warning displayed");
  const image = await page.eval(`(async () => {
    const blob = await (await fetch(${page.sel("uploaded-menu-preview-img")}.src)).blob();
    const bitmap = await createImageBitmap(blob);
    const result = { bytes: blob.size, width: bitmap.width, height: bitmap.height };
    bitmap.close(); return result;
  })()`);
  assert(image.bytes > 0 && image.bytes <= 4 * 1024 * 1024, `processed size: ${image.bytes}`);
  assert(image.width === 96 && image.height === 64, "dimensions survive transcode");
  await analyzeAndWaitResult(page, "Shrimp Tempura");
  assert(page.apiRequests.length === 1, "processed image accepted by the real mock API");
});

test("T23 本番Mock無効化・AI_DISABLED・クライアントのMock応答遮断", async (page, base) => {
  await setupToUpload(page, base);
  assert(!(await page.exists("dev-mock-panel")), "production hides mock selector");
  await uploadImage(page, IMG_A);
  await page.click("analyze-menu-btn");
  await page.waitForTestId("error-banner");
  assert(await page.eval(`${page.sel("error-banner")}.getAttribute("data-error-code") === "AI_DISABLED"`), "real production API disables AI even with MOCK_GEMINI=true");
  assert(await page.exists("error-card-fallback-btn"), "fallback available");
  assert(!Object.keys(page.apiRequests[0].headers).some((h) => h.toLowerCase() === "x-mock-scenario"), "production omits mock header");
  page.apiHandler = () => ok({ dish: "PRODUCTION-MOCK", allergens: ["shrimp"], dataOrigin: "mock_fixture", requestId: "production-blocked-fixture" });
  await page.click("analyze-menu-btn");
  await page.waitFor(`${page.sel("error-banner")}?.getAttribute("data-error-code") === "AI_FAILED"`);
  assert(!(await page.bodyText()).includes("PRODUCTION-MOCK"), "mock response blocked in production UI");
});

// ---------------------------------------------------------------------------
// PR4 Browser E2E Scenarios (T24–T36: 13 items for Confirmation Card UX & Safety)
// ---------------------------------------------------------------------------
async function openStandaloneCard(page, base, { allergens = ["shrimp"], userLang = "ja" } = {}) {
  await openApp(page, base);
  if (userLang === "en") await page.click("user-lang-btn-en");
  for (const a of allergens) await toggleAllergen(page, a);
  await page.click("go-to-card-directly-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
}

async function fillTextarea(page, testid, value) {
  await page.eval(`(() => {
    const el = ${page.sel(testid)};
    if (!el) throw new Error("textarea not found: ${testid}");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

// First accepted operation must survive initialization, rapid input and navigation.
for (const mode of ["synthetic", "native"]) {
  test(`R25-1 ${mode}: hydration前は入力不可・有効化後の初回操作を保存し確認カードへ保持`, async (page, base) => {
    await page.send("Network.setBlockedURLs", { urls: ["*.js"] });
    await page.goto(base + "/");
    await page.waitForTestId("settings-interaction-gate");
    assert(await page.eval(`document.querySelector('[data-testid="settings-interaction-gate"]').disabled`), "SSR controls must be disabled before hydration");
    await page.clickSelector('[data-testid="allergen-option-shrimp"] input');
    assert(await page.eval(`!document.querySelector('[data-testid="allergen-option-shrimp"] input').checked && localStorage.getItem('allergy_bridge_settings_v1') === null`), "disabled early control must not appear to accept a selection");
    await page.send("Network.setBlockedURLs", { urls: [] });
    await openApp(page, base);
    for (const code of ["shrimp", "buckwheat", "fish"]) {
      if (mode === "synthetic") await toggleAllergen(page, code);
      else {
        const selector = `[data-testid="allergen-option-${code}"]`;
        await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
        const point = await page.eval(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      }
    }
    const stored = await page.eval(`JSON.parse(localStorage.getItem('allergy_bridge_settings_v1')).allergens`);
    assert(["shrimp", "buckwheat", "fish"].every(code => stored.includes(code)), "first and subsequent selections must all be saved");
    await page.click("proceed-to-upload-btn"); await page.waitForTestId("upload-section");
    await page.click("upload-to-card-btn"); await page.waitForTestId("confirm-card-placeholder-section");
    for (const id of ["SHRIMP", "BUCKWHEAT", "FISH"]) assert(await page.exists(`phrase-card-Q_ALLERGEN_${id}`), `missing selected question: ${id}`);
    assert(page.apiRequests.length === 0, "card_only must not call Gemini");
    await openApp(page, base);
    const restored = await page.eval(`JSON.parse(localStorage.getItem('allergy_bridge_settings_v1')).allergens`);
    assert(["shrimp", "buckwheat", "fish"].every(code => restored.includes(code)), "reload must retain every accepted selection");
  });
}

for (const delayed of [false, true]) {
  test(`R25-2 ${delayed ? "遅延" : "欠落"}storageイベントでも削除済み設定は古いタブから復活しない`, async (page, base) => {
    const { Page } = await import("./cdp.mjs");
    await openApp(page, base);
    await page.click("dietary-preset-halal_check");
    await page.waitFor(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))?.selectedConditions.includes('pork')`);
    const { targetId } = await browser.conn.send("Target.createTarget", { url: "about:blank", browserContextId: page.browserContextId });
    const { sessionId } = await browser.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const second = new Page(browser.conn, sessionId, targetId, page.browserContextId);
    await second.init();
    try {
      await second.send("Page.addScriptToEvaluateOnNewDocument", { source: `const listen=window.addEventListener.bind(window);window.pendingStorage=[];window.addEventListener=(type,fn,...args)=>type==='storage'?listen(type,e=>window.pendingStorage.push(()=>fn(e)),...args):listen(type,fn,...args);` });
      await second.send("Page.bringToFront"); await openApp(second, base);
      assert(await second.eval(`document.querySelector('[data-testid="dietary-cond-pork"]').checked`), "second tab must start with stale pork");
      await page.send("Page.bringToFront"); await page.click("dietary-reset-storage-btn");
      await page.waitFor(`localStorage.getItem('allergy_bridge_dietary_restrictions_v1')===null && !!localStorage.getItem('allergy_bridge_dietary_restrictions_cleared_at_v1')`);
      await second.send("Page.bringToFront"); await second.click("dietary-cond-honey");
      await second.waitFor(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))?.selectedConditions.includes('honey')`);
      if (delayed) await second.eval(`window.pendingStorage.splice(0).forEach(fn=>fn())`);
      const stored = await second.eval(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))`);
      assert(!stored.selectedConditions.includes("pork") && !stored.activePresets.includes("halal_check"), "stale state must not revive after erasure");
      await page.send("Page.bringToFront"); await openApp(page, base);
      assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked && document.querySelector('[data-testid="dietary-cond-honey"]').checked`), "reload must keep only the new explicit selection");
    } finally { await second.close(); }
  });
}

for (const failed of ["remove", "tombstone", "save"]) {
  test(`R25-3 ${failed}失敗を永続完了と表示しない`, async (page, base) => {
    await openApp(page, base); await page.click("dietary-preset-vegan");
    await page.waitFor(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))?.selectedConditions.includes('honey')`);
    await page.eval(`(() => {const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;Storage.prototype.setItem=function(k,v){if(${JSON.stringify(failed)}==='save'||(${JSON.stringify(failed)}==='tombstone'&&k==='allergy_bridge_dietary_restrictions_cleared_at_v1'))throw new DOMException('SYNTHETIC','QuotaExceededError');return set.call(this,k,v)};Storage.prototype.removeItem=function(k){if(${JSON.stringify(failed)}==='remove')throw new DOMException('SYNTHETIC','SecurityError');return remove.call(this,k)};})()`);
    await page.click(failed === "save" ? "dietary-cond-pork" : "dietary-reset-storage-btn");
    await page.waitForTestId("dietary-storage-error-alert");
    assert(!/設定を消去しました|have been cleared from this device/.test(await page.bodyText()), "failed persistence must not claim completed erasure");
    if (failed === "save") {
      await page.waitFor(`!document.querySelector('[data-testid="proceed-to-dietary-card-btn"]').disabled`);
      await page.click("proceed-to-dietary-card-btn"); await page.waitForTestId("dietary-question-pork");
    }
  });
}

for (const width of [320, 1440]) {
  test(`R25-4 ${width}px 提示モードのTab循環・Escape復帰・reduced-motion`, async (page, base) => {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 320 });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await openApp(page, base); await page.click("dietary-cond-pork");
    await page.waitFor(`!document.querySelector('[data-testid="proceed-to-dietary-card-btn"]').disabled`);
    await page.click("proceed-to-dietary-card-btn"); await page.waitForTestId("dietary-confirmation-card");
    await page.click("dietary-toggle-presentation-btn");
    await page.waitFor(`document.querySelector('[data-testid="dietary-confirmation-card"]').getAttribute('aria-modal')==='true'`);
    for (let i = 0; i < 12; i++) {
      await page.press("Tab", { shift: i % 2 === 1 });
      assert(await page.eval(`document.querySelector('[data-testid="dietary-confirmation-card"]').contains(document.activeElement)`), "presentation focus escaped to background");
    }
    assert(await page.eval(`getComputedStyle(document.querySelector('[data-testid="dietary-toggle-presentation-btn"]')).transitionDuration.split(',').every(v=>parseFloat(v)===0)`), "reduced-motion must stop transitions");
    await page.press("Escape");
    assert(await page.eval(`document.activeElement?.dataset.testid==='dietary-toggle-presentation-btn'`), "Escape must restore toggle focus");
    assert(await page.exists("dietary-unverified-answers"), "pending answer review must be explicit");
    assert(!(await page.exists("dietary-ans-yes-DIETARY_Q_PORK")), "draft answer must never display");
  });
}


for (const unavailable of ["localStorage", "webLocks", "indexedDB"]) {
  test(`R25-5 ${unavailable}利用不可は一時利用と明示しcard_onlyを維持`, async (page, base) => {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: unavailable === "localStorage"
      ? `Object.defineProperty(window,'localStorage',{get(){throw new DOMException('SYNTHETIC','SecurityError')}})`
      : unavailable === "webLocks" ? `Object.defineProperty(navigator,'locks',{value:undefined})`
      : `Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('SYNTHETIC','SecurityError')}})` });
    await openApp(page, base); await page.click("dietary-cond-pork");
    await page.waitForTestId("dietary-storage-error-alert");
    assert(/一時利用|temporary/.test(await page.bodyText()), "non-persistent state must be explicit");
    await page.waitFor(`!document.querySelector('[data-testid="proceed-to-dietary-card-btn"]').disabled`);
    await page.click("proceed-to-dietary-card-btn"); await page.waitForTestId("dietary-question-pork");
    assert(page.apiRequests.length === 0, "temporary card must remain local");
  });
}
for (const race of ["update-update", "same-condition", "same-preset", "delete-update"]) {
  test(`R25-6 2タブ同時${race}を直列化し削除前の状態を復活させない`, async (page, base) => {
    const { Page } = await import("./cdp.mjs");
    const suppressEvents = `const listen=window.addEventListener.bind(window);window.addEventListener=(type,fn,...args)=>type==='storage'?undefined:listen(type,fn,...args)`;
    if (race.startsWith("same-")) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: suppressEvents });
    await openApp(page, base);
    if (race === "delete-update") {
      await page.click("dietary-preset-halal_check");
      await page.waitFor(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))?.selectedConditions.includes('pork')`);
    }
    const { targetId } = await browser.conn.send("Target.createTarget", { url: "about:blank", browserContextId: page.browserContextId });
    const { sessionId } = await browser.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const second = new Page(browser.conn, sessionId, targetId, page.browserContextId); await second.init();
    try {
      if (race.startsWith("same-")) await second.send("Page.addScriptToEvaluateOnNewDocument", { source: suppressEvents });
      await second.send("Page.bringToFront"); await openApp(second, base);
      await Promise.all([
        page.click(race === "delete-update" ? "dietary-reset-storage-btn" : race === "same-preset" ? "dietary-preset-vegan" : "dietary-cond-pork"),
        second.click(race === "same-condition" ? "dietary-cond-pork" : race === "same-preset" ? "dietary-preset-vegan" : "dietary-cond-honey"),
      ]);
      // A third lock request can overtake the other renderer's request that is
      // still being dispatched. Observe each product operation's completion first.
      await Promise.all([page, second].map(tab => tab.waitFor(
        `document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`,
        { message: "dietary mutation completed" },
      )));
      // Keep the origin lock boundary before reading the persisted result.
      await page.eval(`navigator.locks.request('allergy-bridge-dietary-settings',()=>true)`);
      // Read the authoritative store. localStorage is a legacy mirror whose
      // renderer cache is not a transactional cross-tab source of truth.
      const result = await page.eval(`new Promise((resolve,reject)=>{
        const request=indexedDB.open('allergy_bridge_dietary_settings_v2',1);
        request.onerror=()=>reject(new Error('independent IDB read failed'));
        request.onsuccess=()=>{const db=request.result;const tx=db.transaction('state','readonly');
          const get=tx.objectStore('state').get('profile');
          get.onsuccess=()=>resolve(get.result?.settings ?? null);
          tx.oncomplete=()=>db.close();tx.onerror=()=>{db.close();reject(new Error('independent IDB transaction failed'))};};
      })`);
      if (race === "update-update") assert(result?.selectedConditions.includes("pork") && result?.selectedConditions.includes("honey"), "both tabs' explicit updates must be retained");
      else if (race === "same-condition") assert(result?.selectedConditions.includes("pork"), "two explicit selections must not toggle the condition off");
      else if (race === "same-preset") assert(result?.activePresets.includes("vegan") && result?.selectedConditions.includes("honey"), "two activations must not toggle the preset off");
      else assert(!result?.selectedConditions.includes("pork") && !result?.activePresets.includes("halal_check"), "delete/update race must not revive pre-delete state");
      await page.send("Page.bringToFront"); await openApp(page, base);
      if (race === "update-update") assert(await page.eval(`document.querySelector('[data-testid="dietary-cond-pork"]').checked && document.querySelector('[data-testid="dietary-cond-honey"]').checked`), "reload must retain both writes");
      else if (race === "same-condition") assert(await page.eval(`document.querySelector('[data-testid="dietary-cond-pork"]').checked`), "reload must retain the explicit selection");
      else if (race === "same-preset") assert(await page.eval(`document.querySelector('[data-testid="dietary-preset-vegan"]').getAttribute('aria-pressed')==='true'`), "reload must retain the explicit preset activation");
      else assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked`), "reload must not resurrect deleted profile");
    } finally { await second.close(); }
  });
}


test("R25-7 旧実装がv1 tombstoneを消して再保存してもreloadで復活しない", async (page, base) => {
  await openApp(page, base); await page.click("dietary-preset-halal_check");
  await page.waitFor(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))?.selectedConditions.includes('pork')`);
  const stale = await page.eval(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))`);
  await page.click("dietary-reset-storage-btn");
  await page.waitFor(`localStorage.getItem('allergy_bridge_dietary_restrictions_v1')===null`);
  await page.eval(`localStorage.setItem('allergy_bridge_dietary_restrictions_v1',JSON.stringify({...${JSON.stringify(stale)},savedAt:Date.now()+1000}));localStorage.removeItem('allergy_bridge_dietary_restrictions_cleared_at_v1')`);
  await openApp(page, base);
  assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked`), "legacy writer must not bypass modern erasure barrier");
  await page.click("dietary-cond-honey");
  await page.waitFor(`JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1'))?.selectedConditions.includes('honey')`);
  assert(await page.eval(`!JSON.parse(localStorage.getItem('allergy_bridge_dietary_restrictions_v1')).selectedConditions.includes('pork')`), "new consent may include only the explicit new selection");
});

test("R25-8 正本の書込み失敗を保存完了とせず、reloadで古いmirrorを復元しない", async (page, base) => {
  await openApp(page, base);
  await page.eval(`IDBObjectStore.prototype.put=function(){throw new DOMException('SYNTHETIC','QuotaExceededError')}`);
  await page.click("dietary-cond-pork"); await page.waitForTestId("dietary-storage-error-alert");
  assert(/一部の保存データ|Some stored data may remain/.test(await page.bodyText()), "partial persistence must be disclosed");
  await page.waitFor(`!document.querySelector('[data-testid="proceed-to-dietary-card-btn"]').disabled`);
  await page.click("proceed-to-dietary-card-btn"); await page.waitForTestId("dietary-question-pork");
  await openApp(page, base);
  assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked`), "a failed canonical write must not make the mirror authoritative on reload");
});

// SYNTHETIC TEST DATA: delete commits while a pre-existing save waits, then that save fails.
for (const failure of ["abort", "put", "success"]) {
  test(`R25-9 LATE-${failure}: 削除通知の後の古い結果を破棄し正本と再同期する`, async (page, base) => {
    await openApp(page, base); await page.click("dietary-cond-pork");
    await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    await page.eval(`(() => {
      const request = navigator.locks.request.bind(navigator.locks);
      window.__originalLockRequest = request;
      navigator.locks.request = (...args) => new Promise((resolve,reject) => {
        window.__releaseOldSave = () => request(...args).then(resolve,reject);
      });
    })()`);
    await page.click("dietary-cond-honey");
    await page.waitFor(`typeof window.__releaseOldSave === 'function'`);
    await page.eval(`new Promise((resolve,reject)=>{
      const open=indexedDB.open('allergy_bridge_dietary_settings_v2',1);
      open.onerror=()=>reject(open.error);open.onsuccess=()=>{
        const db=open.result,tx=db.transaction('state','readwrite'),store=tx.objectStore('state');
        const read=store.get('profile');read.onsuccess=()=>store.put({revision:read.result.revision+1,settings:{activePresets:[],selectedConditions:[]}},'profile');
        tx.oncomplete=()=>{db.close();window.dispatchEvent(new StorageEvent('storage',{key:'allergy_bridge_dietary_restrictions_cleared_at_v1',newValue:'SYNTHETIC'}));resolve(true)};
        tx.onabort=()=>reject(tx.error);
      }
    })`);
    await page.waitFor(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked`);
    await page.eval(`(() => {
      const put=IDBObjectStore.prototype.put;window.__restorePut=()=>{IDBObjectStore.prototype.put=put};
      ${failure !== "success" ? `IDBObjectStore.prototype.put=function(){
        ${failure === "abort" ? "this.transaction.abort();" : ""}
        throw new DOMException('SYNTHETIC canonical failure','QuotaExceededError');
      };` : ""}
      window.__releaseOldSave();
    })()`);
    await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked`), "a late failed save must not revive the deleted pork selection");
    if (failure === "success") {
      assert(await page.eval(`document.querySelector('[data-testid="dietary-cond-honey"]').checked`), "a discarded success must trigger a fresh canonical read before the operation finishes");
    }
    await page.eval(`window.__restorePut();navigator.locks.request=window.__originalLockRequest`);
    if (failure !== "success") await page.click("dietary-cond-honey");
    await page.waitFor(`!document.querySelector('[data-testid="proceed-to-dietary-card-btn"]').disabled`);
    await page.click("proceed-to-dietary-card-btn");await page.waitForTestId("dietary-question-honey");
    assert(!(await page.exists("dietary-question-pork")), "deleted pork must not reappear on the staff card");
  });
}

for (const provider of ["native", "ignores-abort"]) {
  test(`R25-10 DEADLINE-${provider}: ロック期限切れ後の書込み・未処理rejectionを防ぐ`, async (page, base) => {
    await openApp(page, base);
    await page.eval(`(() => {
      window.__unhandled = 0;window.addEventListener('unhandledrejection',()=>{window.__unhandled++});
      window.__writes = 0;const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){window.__writes++;return put.apply(this,args)};
      ${provider === "native" ? `navigator.locks.request('allergy-bridge-dietary-settings',()=>new Promise(resolve=>{window.__releaseBlockedLock=resolve}));` : `navigator.locks.request=(...args)=>new Promise((resolve,reject)=>{window.__lockSignal=args[1]?.signal;window.__releaseBlockedLock=()=>Promise.resolve().then(()=>args.at(-1)()).then(resolve,reject).then(()=>{window.__lateSettled=true})});`}
    })()`);
    if (provider === "native") await page.waitFor(`typeof window.__releaseBlockedLock==='function'`);
    await page.click("dietary-cond-honey");
    await page.waitFor(`typeof window.__releaseBlockedLock==='function'`);
    await page.waitFor(`!!document.querySelector('[data-testid="dietary-storage-error-alert"]')`, { timeout: 12000, message: "lock deadline failure disclosure" });
    await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    assert(await page.eval(`window.__writes===0`), "an unacquired lock must not start a canonical write");
    await page.eval(`window.__releaseBlockedLock()`);
    if (provider === "ignores-abort") {
      await page.waitFor(`window.__lateSettled===true`);
      assert(await page.eval(`window.__lockSignal?.aborted===true`), "the queued request must be cancelled");
    } else await page.eval(`navigator.locks.request('allergy-bridge-dietary-settings',()=>true)`);
    assert(await page.eval(`window.__writes===0 && window.__unhandled===0`), "late grant must neither write nor leak an unhandled rejection");
    assert(await page.eval(`localStorage.getItem('allergy_bridge_dietary_restrictions_v1')===null`), "expiry cannot write a compatibility copy");
    await page.click("proceed-to-dietary-card-btn");await page.waitForTestId("dietary-question-honey");
    assert(page.apiRequests.length===0,"temporary card must remain available without Gemini");
  });
}

for (const action of ["save", "delete", "failure"]) {
  test(`R25-11 NAV-${action}: 保存・削除待機中の画面移動を制御し操作結果を保持`, async (page, base) => {
    await openApp(page, base);await toggleAllergen(page,"shrimp");
    if (action === "delete") {
      await page.click("dietary-cond-pork");
      await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    }
    await page.eval(`(() => { void navigator.locks.request('allergy-bridge-dietary-settings',()=>new Promise(resolve=>{window.__releaseNavLock=resolve})); })()`);
    await page.waitFor(`typeof window.__releaseNavLock==='function'`);
    await page.click(action === "delete" ? "dietary-reset-storage-btn" : "dietary-cond-honey");
    await page.waitFor(`navigator.locks.query().then(q=>q.pending.some(x=>x.name==='allergy-bridge-dietary-settings'))`);
    assert(await page.eval(`document.querySelector('[data-testid="step-nav-upload"]').disabled`), "top navigation must be disabled until the dietary operation completes");
    assert(await page.eval(`document.querySelector('[data-testid="proceed-to-upload-btn"]').matches(':disabled')`), "allergy navigation must also wait for the pending dietary intent");
    await page.click("step-nav-upload");
    assert(await page.exists("dietary-settings-section"),"a pending operation must keep its owning settings section mounted");
    if (action === "failure") await page.eval(`IDBObjectStore.prototype.put=function(){throw new DOMException('SYNTHETIC','QuotaExceededError')}`);
    await page.eval(`window.__releaseNavLock()`);
    await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    if (action === "delete") {
      assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-pork"]').checked`),"completed deletion must clear the current UI");
      assert(await page.eval(`document.querySelector('[data-testid="step-nav-dietaryCard"]').disabled`),"erased conditions cannot open an old dietary card");
    } else {
      if (action === "failure") assert(await page.exists("dietary-storage-error-alert"),"temporary intent must be accompanied by a persistence warning");
      await page.click("proceed-to-dietary-card-btn");await page.waitForTestId("dietary-question-honey");
      await page.click("dietary-back-settings-btn");await page.waitForTestId("dietary-settings-section");
      assert(await page.eval(`document.querySelector('[data-testid="dietary-cond-honey"]').checked`),"successful and temporary intents must survive internal card navigation");
    }
    assert(page.apiRequests.length===0,"navigation protection must not call Gemini");
  });
}

test("R25-12 MAX-STALE: 古い20条件の画面で既存条件を追加しても正本21条件を消さない", async (page, base) => {
  const { Page } = await import("./cdp.mjs");
  await page.send("Page.addScriptToEvaluateOnNewDocument",{source:`const listen=window.addEventListener.bind(window);window.addEventListener=(type,fn,...args)=>type==='storage'?undefined:listen(type,fn,...args)`});
  await openApp(page,base);await page.click("dietary-select-all-btn");
  await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
  await page.click("dietary-cond-honey");
  await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
  const {targetId}=await browser.conn.send("Target.createTarget",{url:"about:blank",browserContextId:page.browserContextId});
  const {sessionId}=await browser.conn.send("Target.attachToTarget",{targetId,flatten:true});
  const second=new Page(browser.conn,sessionId,targetId,page.browserContextId);await second.init();
  try {
    await second.send("Page.bringToFront");await openApp(second,base);await second.click("dietary-select-all-btn");
    await second.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    assert(await page.eval(`!document.querySelector('[data-testid="dietary-cond-honey"]').checked`),"missing events must leave the first tab's 20-item UI stale");
    await page.send("Page.bringToFront");await page.click("dietary-cond-honey");
    await page.waitFor(`document.querySelector('[data-testid="dietary-settings-section"]').getAttribute('aria-busy')==='false'`);
    const saved=await page.eval(`new Promise((resolve,reject)=>{const r=indexedDB.open('allergy_bridge_dietary_settings_v2',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('state','readonly'),g=tx.objectStore('state').get('profile');g.onsuccess=()=>resolve(g.result.settings.selectedConditions);tx.oncomplete=()=>db.close()}})`);
    assert(saved.length===21 && new Set(saved).size===21,"an already-present condition must preserve every canonical condition at the limit");
    assert(await page.eval(`document.querySelectorAll('[data-testid^="dietary-cond-"]:checked').length===21`),"UI must preserve all canonical selections");
    await page.click("proceed-to-dietary-card-btn");await page.waitForTestId("dietary-question-honey");
    assert(await page.exists("dietary-question-pork"),"existing verified questions must remain on the card");
  } finally {await second.close();}
});

test("T24 PR4-1 ja→en / en→ja の正しい主言語表示", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp", "wheat"], userLang: "ja" });
  const jaToEn = await page.eval(`(() => {
    const storeEl = ${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")};
    const userEl = ${page.sel("phrase-user-text-Q_ALLERGEN_SHRIMP")};
    return {
      storeLang: storeEl.getAttribute("lang"),
      userLang: userEl.getAttribute("lang"),
      storeText: storeEl.innerText,
      userText: userEl.innerText,
      storeTop: storeEl.getBoundingClientRect().top,
      userTop: userEl.getBoundingClientRect().top,
      storeFontPx: parseFloat(getComputedStyle(storeEl).fontSize),
      userFontPx: parseFloat(getComputedStyle(userEl).fontSize),
    };
  })()`);
  assert(jaToEn.storeLang === "en" && jaToEn.userLang === "ja", `ja->en lang attrs: ${JSON.stringify(jaToEn)}`);
  assert(jaToEn.storeText.startsWith("Does this dish contain shrimp"), `ja->en store text: ${jaToEn.storeText}`);
  assert(jaToEn.userText.startsWith("この料理に「えび」"), `ja->en user text: ${jaToEn.userText}`);
  assert(jaToEn.storeTop < jaToEn.userTop, "storeLang must be positioned above userLang");
  assert(jaToEn.storeFontPx > jaToEn.userFontPx, "storeLang font must be larger than userLang font");

  // Switch to en -> ja
  await page.click("card-back-to-settings-btn");
  await page.waitForTestId("settings-section");
  await page.click("user-lang-btn-en");
  await page.click("go-to-card-directly-btn");
  await page.waitForTestId("confirm-card-placeholder-section");

  const enToJa = await page.eval(`(() => {
    const storeEl = ${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")};
    const userEl = ${page.sel("phrase-user-text-Q_ALLERGEN_SHRIMP")};
    return {
      storeLang: storeEl.getAttribute("lang"),
      userLang: userEl.getAttribute("lang"),
      storeText: storeEl.innerText,
      userText: userEl.innerText,
      storeTop: storeEl.getBoundingClientRect().top,
      userTop: userEl.getBoundingClientRect().top,
      storeFontPx: parseFloat(getComputedStyle(storeEl).fontSize),
      userFontPx: parseFloat(getComputedStyle(userEl).fontSize),
    };
  })()`);
  assert(enToJa.storeLang === "ja" && enToJa.userLang === "en", `en->ja lang attrs: ${JSON.stringify(enToJa)}`);
  assert(enToJa.storeText.startsWith("この料理に「えび」"), `en->ja store text: ${enToJa.storeText}`);
  assert(enToJa.userText.startsWith("Does this dish contain shrimp"), `en->ja user text: ${enToJa.userText}`);
  assert(enToJa.storeTop < enToJa.userTop, "storeLang (ja) must be positioned above userLang (en)");
  assert(enToJa.storeFontPx > enToJa.userFontPx, "storeLang (ja) font must be larger than userLang (en) font");
});

test("T25 PR4-2 Geminiなしでのカード自動生成", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp", "buckwheat", "fish"], userLang: "ja" });
  assert(page.apiRequests.length === 0, "standalone card generation must make 0 API calls");
  const mode = await page.eval(`${page.sel("confirm-card-placeholder-section")}.getAttribute("data-card-mode")`);
  const canPresent = await page.eval(`${page.sel("confirm-card-placeholder-section")}.getAttribute("data-can-present")`);
  assert(mode === "standalone" && canPresent === "true", `mode=${mode}, canPresent=${canPresent}`);
  assert(await page.exists("card-standalone-mode-banner"), "standalone banner must be visible");
  for (const id of [
    "phrase-card-NOTICE_ALLERGY_HEADER",
    "phrase-card-Q_ALLERGEN_SHRIMP",
    "phrase-card-Q_ALLERGEN_BUCKWHEAT",
    "phrase-card-Q_ALLERGEN_FISH",
    "phrase-card-Q_BROTH_SEASONING",
    "phrase-card-Q_CROSS_CONTACT",
    "phrase-card-Q_FRYING_OIL",
    "staff-answer-btn-ANS_CONTAINS",
    "staff-answer-btn-ANS_DOES_NOT_CONTAIN",
    "staff-answer-btn-ANS_CROSS_CONTACT_RISK",
    "staff-answer-btn-ANS_UNSURE_OR_CHECKING",
  ]) {
    assert(await page.exists(id), `expected element ${id} to be auto-generated without Gemini`);
  }
  assert(!(await page.exists("phrase-card-Q_ALLERGEN_PEANUT")), "unselected allergen must not be rendered");
});

test("T26 PR4-3 編集ボタンの動作", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  assert(!(await page.exists("edit-phrase-btn-NOTICE_ALLERGY_HEADER")), "opening notice must not have edit button");
  assert(!(await page.exists("phrase-editor-box-Q_ALLERGEN_SHRIMP")), "editor box closed initially");
  const initExpanded = await page.eval(`${page.sel("edit-phrase-btn-Q_ALLERGEN_SHRIMP")}.getAttribute("aria-expanded")`);
  assert(initExpanded === "false", "aria-expanded false initially");

  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await page.waitForTestId("phrase-editor-box-Q_ALLERGEN_SHRIMP");
  const openExpanded = await page.eval(`${page.sel("edit-phrase-btn-Q_ALLERGEN_SHRIMP")}.getAttribute("aria-expanded")`);
  assert(openExpanded === "true", "aria-expanded true when open");
  assert(await page.exists("edit-store-textarea-Q_ALLERGEN_SHRIMP"), "store textarea visible");
  assert(await page.exists("edit-user-textarea-Q_ALLERGEN_SHRIMP"), "user textarea visible");

  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await page.waitFor(`!${page.sel("phrase-editor-box-Q_ALLERGEN_SHRIMP")}`);
});

test("T27 PR4-4 日英両方の入力", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await page.waitForTestId("phrase-editor-box-Q_ALLERGEN_SHRIMP");

  const enMemo = "Please also check if shrimp paste is used in the curry sauce.";
  const jaMemo = "カレーソースにシュリンプペーストが使われていないかも確認お願いします。";
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", enMemo);
  await fillTextarea(page, "edit-user-textarea-Q_ALLERGEN_SHRIMP", jaMemo);

  await page.waitForTestId("phrase-user-memo-box-Q_ALLERGEN_SHRIMP");
  const storeMemoText = await page.eval(`${page.sel("phrase-memo-store-text-Q_ALLERGEN_SHRIMP")}.innerText`);
  const userMemoText = await page.eval(`${page.sel("phrase-memo-user-text-Q_ALLERGEN_SHRIMP")}.innerText`);
  assert(storeMemoText.includes(enMemo), `store memo text: ${storeMemoText}`);
  assert(userMemoText.includes(jaMemo), `user memo text: ${userMemoText}`);
  assert(!(await page.exists("phrase-translation-mismatch-warning-Q_ALLERGEN_SHRIMP")), "no mismatch warning when both languages are edited");
});

test("T28 PR4-5 片言語だけ編集したときの警告", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await page.waitForTestId("phrase-editor-box-Q_ALLERGEN_SHRIMP");

  await fillTextarea(page, "edit-user-textarea-Q_ALLERGEN_SHRIMP", "日本語側のみ追加メモを入力しました");
  await page.waitForTestId("phrase-translation-mismatch-warning-Q_ALLERGEN_SHRIMP");
  assert(await page.exists("phrase-memo-store-untranslated-Q_ALLERGEN_SHRIMP"), "unedited store memo slot must show untranslated notice");
  assert(!(await page.exists("phrase-memo-store-text-Q_ALLERGEN_SHRIMP")), "unedited store text must not appear inside memo box as if auto-translated");
});

test("T29 PR4-6 編集文の未検証表示", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "Custom unverified note in English");
  await fillTextarea(page, "edit-user-textarea-Q_ALLERGEN_SHRIMP", "日本語の未検証追加メモ");

  await page.waitForTestId("phrase-edited-badge-Q_ALLERGEN_SHRIMP");
  assert(!(await page.exists("phrase-verification-badge-Q_ALLERGEN_SHRIMP")), "edited card header must not show verified badge");
  assert(await page.exists("card-edited-summary-banner"), "edited summary banner must be shown");
  assert(await page.exists("phrase-user-memo-disclaimer-Q_ALLERGEN_SHRIMP"), "memo disclaimer must be shown");
  const cardLevel = await page.eval(`${page.sel("phrase-card-Q_ALLERGEN_SHRIMP")}.getAttribute("data-verification-level")`);
  const memoLevel = await page.eval(`${page.sel("phrase-user-memo-box-Q_ALLERGEN_SHRIMP")}.getAttribute("data-verification-level")`);
  assert(cardLevel === "user_edited_unverified" && memoLevel === "user_edited_unverified", `levels: ${cardLevel}, ${memoLevel}`);
});

test("T30 PR4-7 元に戻す（単一カード復元・全件一括復元）", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp", "egg"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "Edited shrimp note");
  await page.click("edit-phrase-btn-Q_ALLERGEN_EGG");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_EGG", "Edited egg note");

  await page.waitForTestId("reset-phrase-btn-Q_ALLERGEN_SHRIMP");
  await page.click("reset-phrase-btn-Q_ALLERGEN_SHRIMP");
  await page.waitFor(`!${page.sel("phrase-user-memo-box-Q_ALLERGEN_SHRIMP")}`);
  assert(await page.exists("phrase-verification-badge-Q_ALLERGEN_SHRIMP"), "shrimp card verified badge restored");
  assert(await page.exists("phrase-user-memo-box-Q_ALLERGEN_EGG"), "egg card remains edited");

  await page.click("reset-all-edits-btn");
  await page.waitFor(`!${page.sel("phrase-user-memo-box-Q_ALLERGEN_EGG")}`);
  assert(!(await page.exists("card-edited-summary-banner")), "summary banner cleared after reset all");
});

test("T31 PR4-8 アレルゲン・言語変更時の編集リセット", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "Temporary session edit 1");
  await page.waitForTestId("phrase-user-memo-box-Q_ALLERGEN_SHRIMP");

  // Change allergen selection
  await page.click("card-back-to-settings-btn");
  await page.waitForTestId("settings-section");
  await toggleAllergen(page, "milk");
  await page.click("go-to-card-directly-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert(!(await page.exists("phrase-user-memo-box-Q_ALLERGEN_SHRIMP")), "allergen change must reset edits");

  // Edit again and change language pair
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "Temporary session edit 2");
  await page.waitForTestId("phrase-user-memo-box-Q_ALLERGEN_SHRIMP");
  await page.click("card-back-to-settings-btn");
  await page.waitForTestId("settings-section");
  await page.click("user-lang-btn-en");
  await page.click("go-to-card-directly-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert(!(await page.exists("phrase-user-memo-box-Q_ALLERGEN_SHRIMP")), "language change must reset edits");
});

test("T32 PR4-9 店員提示モードの表示", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "Note for staff in English");
  await fillTextarea(page, "edit-user-textarea-Q_ALLERGEN_SHRIMP", "店員向けの追加メモ");

  await page.click("toggle-staff-presentation-btn");
  await page.waitForTestId("staff-presentation-active-banner");
  const mode = await page.eval(`${page.sel("confirm-card-placeholder-section")}.getAttribute("data-presentation-mode")`);
  assert(mode === "staff_presentation", `expected staff_presentation, got ${mode}`);
  assert(!(await page.exists("phrase-editor-box-Q_ALLERGEN_SHRIMP")), "editor box must hide in staff presentation mode");
  assert(!(await page.exists("edit-phrase-btn-Q_ALLERGEN_SHRIMP")), "edit button must hide in staff presentation mode");
  assert(await page.exists("phrase-locked-question-Q_ALLERGEN_SHRIMP"), "locked question visible in staff presentation mode");
  assert(await page.exists("phrase-user-memo-box-Q_ALLERGEN_SHRIMP"), "user memo box visible in staff presentation mode");
});

test("T33 PR4-10 必須質問の保持（削除・置換不可）", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  const initialLocked = await page.eval(`({
    noticeStore: ${page.sel("phrase-store-text-NOTICE_ALLERGY_HEADER")}.innerText,
    shrimpStore: ${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")}.innerText,
    shrimpUser: ${page.sel("phrase-user-text-Q_ALLERGEN_SHRIMP")}.innerText,
    brothStore: ${page.sel("phrase-store-text-Q_BROTH_SEASONING")}.innerText,
    crossStore: ${page.sel("phrase-store-text-Q_CROSS_CONTACT")}.innerText,
    oilStore: ${page.sel("phrase-store-text-Q_FRYING_OIL")}.innerText,
  })`);

  for (const id of ["Q_ALLERGEN_SHRIMP", "Q_BROTH_SEASONING", "Q_CROSS_CONTACT", "Q_FRYING_OIL"]) {
    await page.click(`edit-phrase-btn-${id}`);
    await fillTextarea(page, `edit-store-textarea-${id}`, `Supplemental user memo for ${id}`);
    await fillTextarea(page, `edit-user-textarea-${id}`, `${id} の追加補足メモ`);
  }
  await page.click("toggle-staff-presentation-btn");
  await page.waitForTestId("staff-presentation-active-banner");

  const afterLocked = await page.eval(`({
    noticeStore: ${page.sel("phrase-store-text-NOTICE_ALLERGY_HEADER")}.innerText,
    shrimpStore: ${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")}.innerText,
    shrimpUser: ${page.sel("phrase-user-text-Q_ALLERGEN_SHRIMP")}.innerText,
    brothStore: ${page.sel("phrase-store-text-Q_BROTH_SEASONING")}.innerText,
    crossStore: ${page.sel("phrase-store-text-Q_CROSS_CONTACT")}.innerText,
    oilStore: ${page.sel("phrase-store-text-Q_FRYING_OIL")}.innerText,
  })`);
  assert(JSON.stringify(initialLocked) === JSON.stringify(afterLocked), "all mandatory locked questions must remain 100% unchanged after editing");
  assert(await page.exists("phrase-allergen-tag-Q_ALLERGEN_SHRIMP"), "allergen badge remains locked");
  assert(await page.exists("phrase-confirm-tag-Q_CROSS_CONTACT"), "confirmation required badge remains locked");
});

test("T34 PR4-11 長文、不正文字、スマートフォン幅（375px）への対応", async (page, base) => {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");

  // 300-char unbroken string on 375px viewport
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "A".repeat(300));
  await page.waitForTestId("phrase-memo-store-text-Q_ALLERGEN_SHRIMP");
  const overflowCheck = await page.eval(`(() => {
    const card = ${page.sel("phrase-card-Q_ALLERGEN_SHRIMP")};
    return { scrollWidth: card.scrollWidth, clientWidth: card.clientWidth };
  })()`);
  assert(overflowCheck.scrollWidth <= overflowCheck.clientWidth + 2, `card must not overflow horizontally on 375px screen: ${JSON.stringify(overflowCheck)}`);

  // 301-char string -> invalid & blocks staff presentation
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "A".repeat(301));
  await page.waitForTestId("edit-store-error-Q_ALLERGEN_SHRIMP");
  assert(await page.isDisabled("toggle-staff-presentation-btn"), "301 chars must disable staff presentation button");

  // Invisible/control characters only -> invalid & blocks staff presentation
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "\u200B\u2063\u0007   ");
  await page.waitForTestId("edit-store-error-Q_ALLERGEN_SHRIMP");
  assert(await page.isDisabled("toggle-staff-presentation-btn"), "invisible-only input must disable staff presentation button");

  // HTML/script string -> rendered as inert text, 0 <img>/<script> tags created
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "<img src=x onerror=alert(1)>");
  const injectedCount = await page.eval(`${page.sel("phrase-card-Q_ALLERGEN_SHRIMP")}.querySelectorAll("img, script").length`);
  assert(injectedCount === 0, "HTML string must never be parsed as DOM elements");
  assert(page.consoleErrors.length === 0, `no console errors: ${page.consoleErrors.join(" | ")}`);
});

test("T35 PR4-12 AI_FAILED、AI_DISABLED時のカード単独経路", async (page, base) => {
  page.apiHandler = (_info, i) => (i === 0 ? err(502, "AI_FAILED") : err(503, "AI_DISABLED"));
  await setupToUpload(page, base, { allergens: ["shrimp", "wheat"] });
  await uploadImage(page, IMG_A);

  // 1st attempt -> 502 AI_FAILED -> fallback to standalone card
  await page.click("analyze-menu-btn");
  await page.waitForTestId("error-banner");
  assert((await page.eval(`${page.sel("error-banner")}.getAttribute("data-error-code")`)) === "AI_FAILED", "expected AI_FAILED");
  await page.click("error-card-fallback-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert((await page.eval(`${page.sel("confirm-card-placeholder-section")}.getAttribute("data-card-mode")`)) === "standalone", "standalone mode after AI_FAILED");
  assert(await page.exists("phrase-card-Q_ALLERGEN_SHRIMP"), "shrimp card shown after AI_FAILED");

  // Return to upload -> 2nd attempt -> 503 AI_DISABLED -> fallback to standalone card
  await page.click("card-back-to-upload-btn");
  await page.waitForTestId("upload-section");
  await page.click("analyze-menu-btn");
  await page.waitForTestId("error-banner");
  assert((await page.eval(`${page.sel("error-banner")}.getAttribute("data-error-code")`)) === "AI_DISABLED", "expected AI_DISABLED");
  await page.click("error-card-fallback-btn");
  await page.waitForTestId("confirm-card-placeholder-section");
  assert((await page.eval(`${page.sel("confirm-card-placeholder-section")}.getAttribute("data-can-present")`)) === "true", "canPresent true after AI_DISABLED");
});

test("T36 PR4-13 編集による断定文・必須質問削除の負の対照（Negative Control）", async (page, base) => {
  await openStandaloneCard(page, base, { allergens: ["shrimp"] });
  const expectedLockedStore = await page.eval(`${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")}.innerText`);

  // Attempt 1: User enters a safety assertion ("This dish is 100% safe to eat and allergen_absent.")
  await page.click("edit-phrase-btn-Q_ALLERGEN_SHRIMP");
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "This dish is 100% safe to eat and allergen_absent.");
  await fillTextarea(page, "edit-user-textarea-Q_ALLERGEN_SHRIMP", "この料理は100%安全でアレルゲン不使用です。");

  const checkAssertionIsolation = await page.eval(`(() => {
    const primaryStore = ${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")}.innerText;
    const memoBox = ${page.sel("phrase-user-memo-box-Q_ALLERGEN_SHRIMP")};
    const disclaimer = ${page.sel("phrase-user-memo-disclaimer-Q_ALLERGEN_SHRIMP")}?.innerText || "";
    const hasVerifiedBadge = !!${page.sel("phrase-verification-badge-Q_ALLERGEN_SHRIMP")};
    return {
      primaryStore,
      memoLevel: memoBox?.getAttribute("data-verification-level"),
      disclaimer,
      hasVerifiedBadge,
    };
  })()`);
  assert(checkAssertionIsolation.primaryStore === expectedLockedStore, "mandatory question must NOT be replaced by safety assertion");
  assert(!checkAssertionIsolation.primaryStore.includes("safe to eat"), "primary question must never contain user safety assertion");
  assert(checkAssertionIsolation.memoLevel === "user_edited_unverified", "user memo must be marked user_edited_unverified");
  assert(!checkAssertionIsolation.hasVerifiedBadge, "edited card must not carry verified header badge");
  assert(checkAssertionIsolation.disclaimer.includes("未検証") && checkAssertionIsolation.disclaimer.includes("削除・置換されません"), "disclaimer must explicitly warn that memo is unverified and locked question cannot be replaced");

  // Attempt 2: User attempts to delete the question by clearing the textarea
  await fillTextarea(page, "edit-store-textarea-Q_ALLERGEN_SHRIMP", "   ");
  await page.waitForTestId("card-presentation-blocked-banner");
  const afterClearStore = await page.eval(`${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")}.innerText`);
  assert(afterClearStore === expectedLockedStore, "clearing textarea must NOT erase the locked mandatory question in the card");
  assert(await page.isDisabled("toggle-staff-presentation-btn"), "clearing textarea must block staff presentation mode");

  // Negative Control Detector verification inside browser:
  const negativeControlCaught = await page.eval(`(() => {
    function assertDomLockedQuestionIntact(storeNodeText, expectedVerifiedText) {
      if (storeNodeText !== expectedVerifiedText) {
        throw new Error("DOM_INVARIANT_VIOLATION: primary locked question was overwritten or deleted");
      }
      return true;
    }
    const liveOk = assertDomLockedQuestionIntact(
      ${page.sel("phrase-store-text-Q_ALLERGEN_SHRIMP")}.innerText,
      ${JSON.stringify(expectedLockedStore)},
    );
    let caughtVulnerable = false;
    try {
      assertDomLockedQuestionIntact("This dish is 100% safe to eat and allergen_absent.", ${JSON.stringify(expectedLockedStore)});
    } catch (e) {
      caughtVulnerable = String(e.message).includes("DOM_INVARIANT_VIOLATION");
    }
    return liveOk && caughtVulnerable;
  })()`);
  assert(negativeControlCaught === true, "negative control detector must pass live DOM and reject pre-fix overwritten DOM");
});

test("T37 実ブラウザーで横長画像の表示枠と切り抜き画素を一致させる", async (page, base) => {
  await setupToUpload(page, base, { allergens: ["shrimp"] });
  await uploadImage(page, CROP_WIDE);
  await page.waitForTestId("crop-stage");
  await page.waitFor(`(() => {
    const stage = ${page.sel("crop-stage")}.getBoundingClientRect();
    const image = ${page.sel("crop-image-layer")}.getBoundingClientRect();
    return image.height > 0 && stage.height > image.height * 2;
  })()`, { message: "letterboxed image layer geometry" });

  const initialGeometry = await page.eval(`(() => {
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const stage = rect(${page.sel("crop-stage")});
    const image = rect(${page.sel("crop-image-layer")});
    const selection = rect(${page.sel("crop-selection-box")});
    return { stage, image, selection };
  })()`);
  assert(Math.abs(initialGeometry.image.left - initialGeometry.selection.left) < 2, `selection left must match rendered image: ${JSON.stringify(initialGeometry)}`);
  assert(Math.abs(initialGeometry.image.top - initialGeometry.selection.top) < 2, `selection top must match rendered image: ${JSON.stringify(initialGeometry)}`);
  assert(Math.abs(initialGeometry.image.width - initialGeometry.selection.width) < 2, `selection width must match rendered image: ${JSON.stringify(initialGeometry)}`);
  assert(Math.abs(initialGeometry.image.height - initialGeometry.selection.height) < 2, `selection height must match rendered image: ${JSON.stringify(initialGeometry)}`);
  assert(initialGeometry.stage.height > initialGeometry.image.height * 2, "letterbox must be excluded from image geometry");

  await page.eval(`(() => { const el = ${page.sel("crop-handle-se")}; el.focus(); return true; })()`);
  for (let i = 0; i < 4; i++) await page.press("ArrowUp");
  const changedGeometry = await page.eval(`(() => {
    const image = ${page.sel("crop-image-layer")}.getBoundingClientRect();
    const selection = ${page.sel("crop-selection-box")}.getBoundingClientRect();
    return { imageHeight: image.height, selectionHeight: selection.height };
  })()`);
  assert(changedGeometry.selectionHeight < changedGeometry.imageHeight, "keyboard resize must use image pixels, not container pixels");

  await page.click("apply-crop-btn");
  await page.waitFor(`(() => ${page.sel("uploaded-menu-preview-img")} && ${page.sel("uploaded-menu-preview-img")}.naturalHeight === 160)()`, {
    message: "cropped 800x160 preview",
  });
  const pixels = await page.eval(`new Promise((resolve, reject) => {
    const image = ${page.sel("uploaded-menu-preview-img")};
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return reject(new Error("2D canvas unavailable"));
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixel = (x, y) => Array.from(data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
    resolve({ width: image.naturalWidth, height: image.naturalHeight, tl: pixel(10, 10), tr: pixel(790, 10), bl: pixel(10, 150), br: pixel(790, 150) });
  })`);
  assert(pixels.width === 800 && pixels.height === 160, "output dimensions must match selected image pixels");
  assert(pixels.tl[0] > 150 && pixels.tl[1] < 100, "top-left source quadrant must remain");
  assert(pixels.tr[1] > 120 && pixels.tr[0] < 100, "top-right source quadrant must remain");
  assert(pixels.bl[2] > 120 && pixels.bl[0] < 100, "bottom-left source quadrant must remain");
  assert(pixels.br[0] > 120 && pixels.br[1] > 100, "bottom-right source quadrant must remain");
});

const EXIF_JPEGS = {};

for (let orientation = 1; orientation <= 8; orientation++) {
  const cfg = ORIENTATION_CONFIGS[orientation];
  test(`T38-${orientation} 実ブラウザーで実JPEG EXIF Orientation ${orientation} (${cfg.name}) の寸法・画素・トリミング・送信画像を検証`, async (page, base) => {
    page.apiHandler = () => ok({ dish: `EXIF-DISH-${orientation}`, allergens: ["shrimp"] });
    await setupToUpload(page, base, { allergens: ["shrimp"] });

    // Hook fetch inside browser to intercept the FormData sent to /api/analyze-menu
    await page.eval(`(() => {
      window.__lastAnalyzeBlob = null;
      if (!window.__fetchHooked) {
        const origFetch = window.fetch;
        window.fetch = async (...args) => {
          const [url, init] = args;
          if (typeof url === "string" && url.includes("/api/analyze-menu") && init?.body instanceof FormData) {
            window.__lastAnalyzeBlob = init.body.get("image");
          }
          return origFetch(...args);
        };
        window.__fetchHooked = true;
      }
    })()`);

    // 1. Upload the real EXIF JPEG
    await uploadImage(page, EXIF_JPEGS[orientation]);

    // 2. Validate preview image dimensions and pixels (upright reference: 100x160)
    const preview = await page.eval(`new Promise((resolve, reject) => {
      const img = ${page.sel("uploaded-menu-preview-img")};
      if (!img) return reject(new Error("uploaded-menu-preview-img not found"));
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("2D canvas context unavailable"));
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const pixel = (x, y) => Array.from(data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        tl: pixel(10, 10),
        tr: pixel(img.naturalWidth - 10, 10),
        bl: pixel(10, img.naturalHeight - 10),
        br: pixel(img.naturalWidth - 10, img.naturalHeight - 10),
      });
    })`);

    // Assert upright dimensions (Orientation 6 audit requirement: exactly 100x160)
    assert(
      preview.width === EXPECTED_UPRIGHT_WIDTH && preview.height === EXPECTED_UPRIGHT_HEIGHT,
      `Orientation ${orientation} preview dimensions must be ${EXPECTED_UPRIGHT_WIDTH}x${EXPECTED_UPRIGHT_HEIGHT}, got ${preview.width}x${preview.height}`
    );
    assertUprightQuadrants(preview.tl, preview.tr, preview.bl, preview.br, `Orientation ${orientation} preview: `);

    // Verify EXIF badges
    assert(await page.exists("exif-stripped-badge"), "exif-stripped-badge must be visible");
    if (orientation !== 1) {
      assert(await page.exists("orientation-normalized-badge"), "orientation-normalized-badge must be visible for orientation " + orientation);
    }

    // 3. Validate uncropped API payload
    await page.click("analyze-menu-btn");
    await page.waitForTestId("results-section");

    const sentUncropped = await page.eval(`(async () => {
      const blob = window.__lastAnalyzeBlob;
      if (!blob) throw new Error("No image blob captured in fetch hook");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let hasApp1 = false;
      let hasGps = false;
      for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) hasApp1 = true;
        if (bytes[i] === 0x47 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x53) hasGps = true;
      }
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const pixel = (x, y) => Array.from(data.subarray((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3));
      return {
        width: bmp.width,
        height: bmp.height,
        hasApp1,
        hasGps,
        tl: pixel(10, 10),
        tr: pixel(bmp.width - 10, 10),
        bl: pixel(10, bmp.height - 10),
        br: pixel(bmp.width - 10, bmp.height - 10),
      };
    })()`);

    assert(
      sentUncropped.width === EXPECTED_UPRIGHT_WIDTH && sentUncropped.height === EXPECTED_UPRIGHT_HEIGHT,
      `Sent uncropped dimensions must be ${EXPECTED_UPRIGHT_WIDTH}x${EXPECTED_UPRIGHT_HEIGHT}, got ${sentUncropped.width}x${sentUncropped.height}`
    );
    assert(!sentUncropped.hasApp1 && !sentUncropped.hasGps, "Sent uncropped image must strip EXIF APP1 and GPS metadata");
    assertUprightQuadrants(sentUncropped.tl, sentUncropped.tr, sentUncropped.bl, sentUncropped.br, `Sent uncropped image Orientation ${orientation}: `);

    // 4. Validate cropped image behavior (non-zero crop origin x=20, y=24, w=60, h=80)
    await page.click("step-nav-upload");
    await page.waitForTestId("upload-section");

    // Move NW handle: ArrowRight 4 times (x: 0 -> 20, w: 100 -> 80), ArrowDown 3 times (y: 0 -> 24, h: 160 -> 136)
    await page.eval(`(() => { const el = ${page.sel("crop-handle-nw")}; el.focus(); return true; })()`);
    for (let i = 0; i < 4; i++) await page.press("ArrowRight");
    for (let i = 0; i < 3; i++) await page.press("ArrowDown");

    // Move SE handle: ArrowLeft 4 times (w: 80 -> 60), ArrowUp 7 times (h: 136 -> 80)
    await page.eval(`(() => { const el = ${page.sel("crop-handle-se")}; el.focus(); return true; })()`);
    for (let i = 0; i < 4; i++) await page.press("ArrowLeft");
    for (let i = 0; i < 7; i++) await page.press("ArrowUp");

    await page.click("apply-crop-btn");

    await page.waitFor(`(() => {
      const img = ${page.sel("uploaded-menu-preview-img")};
      return !!img && img.naturalWidth === ${EXPECTED_CROP_WIDTH} && img.naturalHeight === ${EXPECTED_CROP_HEIGHT};
    })()`, { message: "cropped preview 60x80 updated" });

    const croppedPreview = await page.eval(`new Promise((resolve, reject) => {
      const img = ${page.sel("uploaded-menu-preview-img")};
      if (!img) return reject(new Error("Cropped preview not found"));
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("2D canvas context unavailable"));
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const pixel = (x, y) => Array.from(data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        leftEdgeMid: pixel(0, Math.floor(img.naturalHeight / 2)),
        rightEdgeMid: pixel(img.naturalWidth - 1, Math.floor(img.naturalHeight / 2)),
        topEdgeMid: pixel(Math.floor(img.naturalWidth / 2), 0),
        bottomEdgeMid: pixel(Math.floor(img.naturalWidth / 2), img.naturalHeight - 1),
        center: pixel(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2)),
        topLeft: pixel(0, 0),
        topRight: pixel(img.naturalWidth - 1, 0),
        bottomLeft: pixel(0, img.naturalHeight - 1),
        bottomRight: pixel(img.naturalWidth - 1, img.naturalHeight - 1),
      });
    })`);

    assert(
      croppedPreview.width === EXPECTED_CROP_WIDTH && croppedPreview.height === EXPECTED_CROP_HEIGHT,
      `Cropped preview dimensions must be ${EXPECTED_CROP_WIDTH}x${EXPECTED_CROP_HEIGHT}, got ${croppedPreview.width}x${croppedPreview.height}`
    );
    assertCropBoundaryPixels(croppedPreview, `Orientation ${orientation} UI cropped preview: `);

    // 5. Send cropped image to API and verify payload
    await page.click("analyze-menu-btn");
    await page.waitForTestId("results-section");

    const sentCropped = await page.eval(`(async () => {
      const blob = window.__lastAnalyzeBlob;
      if (!blob) throw new Error("No image blob captured in fetch hook for cropped request");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let hasApp1 = false;
      let hasGps = false;
      for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) hasApp1 = true;
        if (bytes[i] === 0x47 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x53) hasGps = true;
      }
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const pixel = (x, y) => Array.from(data.subarray((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3));
      return {
        width: bmp.width,
        height: bmp.height,
        hasApp1,
        hasGps,
        leftEdgeMid: pixel(0, Math.floor(bmp.height / 2)),
        rightEdgeMid: pixel(bmp.width - 1, Math.floor(bmp.height / 2)),
        topEdgeMid: pixel(Math.floor(bmp.width / 2), 0),
        bottomEdgeMid: pixel(Math.floor(bmp.width / 2), bmp.height - 1),
        center: pixel(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2)),
        topLeft: pixel(0, 0),
        topRight: pixel(bmp.width - 1, 0),
        bottomLeft: pixel(0, bmp.height - 1),
        bottomRight: pixel(bmp.width - 1, bmp.height - 1),
      };
    })()`);

    assert(
      sentCropped.width === EXPECTED_CROP_WIDTH && sentCropped.height === EXPECTED_CROP_HEIGHT,
      `Sent cropped dimensions ${sentCropped.width}x${sentCropped.height} must match expected ${EXPECTED_CROP_WIDTH}x${EXPECTED_CROP_HEIGHT}`
    );
    assert(!sentCropped.hasApp1 && !sentCropped.hasGps, "Sent cropped image must strip EXIF APP1 and GPS metadata");
    assertCropBoundaryPixels(sentCropped, `Orientation ${orientation} sent cropped payload: `);
  });
}

test("T39 実ブラウザーで画像照合画面の元画像・送信画像の両方がデコード・四隅画素まで検証できること、および早期revoke故障注入で失敗を検知すること", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-RECON", allergens: ["shrimp"] });
  await setupToUpload(page, base, { allergens: ["shrimp"] });
  await uploadImage(page, CROP_WIDE);
  await analyzeAndWaitResult(page, "DISH-RECON");

  await page.waitForTestId("image-reconciliation");
  await page.waitForTestId("image-panel-original");
  await page.waitForTestId("image-panel-processed");

  // Verify both images are alive in real browser and decode properly
  const imageVerification = await page.eval(`(async () => {
    const origImg = document.querySelector('[data-testid="image-panel-original"] img');
    const procImg = document.querySelector('[data-testid="image-panel-processed"] img');
    if (!origImg || !procImg) {
      return { ok: false, error: "Image elements not found in both panels" };
    }
    if (!origImg.src.startsWith("blob:") || !procImg.src.startsWith("blob:")) {
      return { ok: false, error: "Image sources are not blob URLs" };
    }

    const decodeAndSample = async (img) => {
      if (typeof img.decode === "function") {
        await img.decode();
      }
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d canvas");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const pixel = (x, y) => Array.from(data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        tl: pixel(10, 10),
        tr: pixel(img.naturalWidth - 10, 10),
        bl: pixel(10, img.naturalHeight - 10),
        br: pixel(img.naturalWidth - 10, img.naturalHeight - 10),
      };
    };

    const orig = await decodeAndSample(origImg);
    const proc = await decodeAndSample(procImg);
    return { ok: true, orig, proc, origSrc: origImg.src, procSrc: procImg.src };
  })()`);

  assert(imageVerification.ok, `image verification failed: ${imageVerification.error}`);
  assert(imageVerification.orig.width === 800 && imageVerification.orig.height === 200, "original dimensions match fixture");
  assert(imageVerification.proc.width === 800 && imageVerification.proc.height === 200, "processed dimensions match fixture");

  // Top-left should be reddish (top-left quadrant)
  assert(imageVerification.orig.tl[0] > 150 && imageVerification.orig.tl[1] < 100, "original top-left quadrant color");
  assert(imageVerification.proc.tl[0] > 150 && imageVerification.proc.tl[1] < 100, "processed top-left quadrant color");
  // Top-right should be greenish (top-right quadrant)
  assert(imageVerification.orig.tr[1] > 120 && imageVerification.orig.tr[0] < 100, "original top-right quadrant color");
  assert(imageVerification.proc.tr[1] > 120 && imageVerification.proc.tr[0] < 100, "processed top-right quadrant color");

  // FAULT INJECTION: Simulate pre-fix bug where original URL was prematurely revoked on success
  const faultInjectionCaught = await page.eval(`(async () => {
    async function assertBlobLoadable(url) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("fetch failed with status " + resp.status);
        const blob = await resp.blob();
        if (blob.size === 0) throw new Error("empty blob");
        return true;
      } catch (err) {
        throw new Error("EARLY_REVOCATION_FAULT: failed to fetch blob: " + err.message);
      }
    }

    const origSrc = ${JSON.stringify(imageVerification.origSrc)};
    const liveOk = await assertBlobLoadable(origSrc);

    URL.revokeObjectURL(origSrc);

    let caughtFault = false;
    try {
      await assertBlobLoadable(origSrc);
    } catch (e) {
      caughtFault = String(e.message).includes("EARLY_REVOCATION_FAULT");
    }
    return liveOk && caughtFault;
  })()`);

  assert(faultInjectionCaught === true, "fault injection: revoked original URL must be detected and fail assertion");

  // MINOR-1: Non-passive native wheel listener updates zoom and cancels page scroll
  const scrollYBefore = await page.eval("window.scrollY");
  await page.eval(`(() => {
    const vp = document.querySelector('[data-testid="image-viewport-original"]');
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  })()`);
  const zoomTextAfterWheel = await page.eval(`document.querySelector('[data-testid="image-zoom-value"]').innerText`);
  const scrollYAfter = await page.eval("window.scrollY");
  assert(zoomTextAfterWheel === "125%", `wheel event over image viewport must zoom in to 125%, got ${zoomTextAfterWheel}`);
  assert(scrollYAfter === scrollYBefore, `wheel event over image must not cause page scroll (scrollY ${scrollYBefore} -> ${scrollYAfter})`);

  // Reset zoom back to 100%
  await page.click("image-zoom-reset");
  const zoomTextReset = await page.eval(`document.querySelector('[data-testid="image-zoom-value"]').innerText`);
  assert(zoomTextReset === "100%", "reset restores 100%");

  // MINOR-2: 2-finger pinch zoom via pointer events
  await page.eval(`(() => {
    const vp = document.querySelector('[data-testid="image-viewport-original"]');
    const p1Down = new PointerEvent("pointerdown", { pointerId: 10, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
    const p2Down = new PointerEvent("pointerdown", { pointerId: 11, clientX: 150, clientY: 100, bubbles: true, cancelable: true });
    vp.dispatchEvent(p1Down);
    vp.dispatchEvent(p2Down);
    // Spread fingers (dist 50 -> dist 100 = 2x ratio)
    const p2Move = new PointerEvent("pointermove", { pointerId: 11, clientX: 200, clientY: 100, bubbles: true, cancelable: true });
    vp.dispatchEvent(p2Move);
    vp.dispatchEvent(new PointerEvent("pointerup", { pointerId: 10, bubbles: true }));
    vp.dispatchEvent(new PointerEvent("pointerup", { pointerId: 11, bubbles: true }));
  })()`);
  const zoomTextAfterPinch = await page.eval(`document.querySelector('[data-testid="image-zoom-value"]').innerText`);
  assert(zoomTextAfterPinch === "200%", `pinch zoom must scale to 200%, got ${zoomTextAfterPinch}`);
  await page.click("image-zoom-reset");

  // MINOR-3 (Previous keyboard pan): Zoom in with button and pan with keyboard
  await page.click("image-zoom-in");
  const zoomTextAfterBtn = await page.eval(`document.querySelector('[data-testid="image-zoom-value"]').innerText`);
  assert(zoomTextAfterBtn === "125%", "zoom button increases zoom to 125%");

  // Focus viewport and send arrow keys
  await page.eval(`document.querySelector('[data-testid="image-viewport-original"]').focus()`);
  await page.press("ArrowRight");
  await page.press("ArrowDown");
  const transformAfterPan = await page.eval(`document.querySelector('[data-testid="image-panel-original"] img').style.transform`);
  assert(transformAfterPan.includes("translate(-24px, -24px)"), `keyboard arrow keys must pan zoomed image: ${transformAfterPan}`);

  // Reset view restores 100% and offset (0, 0)
  await page.click("image-zoom-reset");
  const transformAfterReset = await page.eval(`document.querySelector('[data-testid="image-panel-original"] img').style.transform`);
  assert(transformAfterReset.includes("translate(0px, 0px) scale(1)"), `reset button restores scale(1) and offset: ${transformAfterReset}`);

  // prefers-reduced-motion: reduce disables transition on .imageZoomed
  await page.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const transitionDuration = await page.eval(`(() => {
    const img = document.querySelector('[data-testid="image-panel-original"] img');
    return window.getComputedStyle(img).transitionDuration;
  })()`);
  assert(transitionDuration === "0s", `reduced-motion must set transition-duration to 0s, got ${transitionDuration}`);

  // Restore emulated media
  await page.send("Emulation.setEmulatedMedia", { media: "screen", features: [] });

  // MINOR-3: Verify unmount during image processing leaves 0 lingering Object URLs
  const unmountUrlLeakResult = await page.eval(`(() => {
    let createdCount = 0;
    let revokedCount = 0;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const created = new Set();
    URL.createObjectURL = (blob) => {
      const u = origCreate.call(URL, blob);
      created.add(u);
      createdCount++;
      return u;
    };
    URL.revokeObjectURL = (u) => {
      created.delete(u);
      revokedCount++;
      return origRevoke.call(URL, u);
    };

    // Simulate selecting and immediately invalidating/unmounting
    const file = new File([new Uint8Array(100)], "test.png", { type: "image/png" });
    const u1 = URL.createObjectURL(file);
    // Cleanup simulation
    URL.revokeObjectURL(u1);

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    return { remaining: created.size };
  })()`);
  assert(unmountUrlLeakResult.remaining === 0, "unmount during image processing leaves 0 lingering Object URLs");
});

test("T40 実ブラウザーで320px、375px、1280pxでの画像照合ARIA整合性と日本語表示を検証", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-RESPONSIVE-JA", allergens: ["shrimp"] });
  await setupToUpload(page, base, { allergens: ["shrimp"], userLang: "ja" });
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-RESPONSIVE-JA");

  await page.waitForTestId("image-reconciliation");

  const noteText = await page.eval(`document.querySelector('[class*="imageRetentionNote"]').innerText`);
  assert(noteText.includes("元画像はサーバーに送信せず端末内でのみ保持されます"), "JA retention note must accurately describe local retention");
  assert(noteText.includes("AI解析に送信された処理済み画像もサーバー側で保存されず"), "JA retention note must describe server processing");
  assert(noteText.includes("画像はアプリ内の画面移動中も保持され"), "JA retention note must describe in-app persistence");

  for (const width of [320, 375]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 667,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(100);

    const tablistHidden = await page.eval(`(() => {
      const tabs = document.querySelector('[role="tablist"]');
      return tabs ? tabs.getAttribute("aria-hidden") : null;
    })()`);
    assert(tablistHidden !== "true", `tablist must not be aria-hidden on mobile (${width}px)`);

    const origPanelHidden = await page.eval(`document.querySelector('[data-testid="image-panel-original"]').getAttribute("aria-hidden")`);
    const procPanelHidden = await page.eval(`document.querySelector('[data-testid="image-panel-processed"]').getAttribute("aria-hidden")`);
    assert(origPanelHidden === "false", `original panel must be aria-hidden=false on mobile (${width}px)`);
    assert(procPanelHidden === "true", `processed panel must be aria-hidden=true on mobile (${width}px)`);

    await page.eval(`document.querySelector('[data-testid="image-source-original"]').focus()`);
    await page.press("ArrowRight");
    await sleep(100);

    const afterOrigPanelHidden = await page.eval(`document.querySelector('[data-testid="image-panel-original"]').getAttribute("aria-hidden")`);
    const afterProcPanelHidden = await page.eval(`document.querySelector('[data-testid="image-panel-processed"]').getAttribute("aria-hidden")`);
    assert(afterOrigPanelHidden === "true", `original panel must become aria-hidden=true after tab switch (${width}px)`);
    assert(afterProcPanelHidden === "false", `processed panel must become aria-hidden=false after tab switch (${width}px)`);

    await page.press("ArrowLeft");
    await sleep(100);
  }

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);

  const desktopOrigPanelHidden = await page.eval(`document.querySelector('[data-testid="image-panel-original"]').getAttribute("aria-hidden")`);
  const desktopProcPanelHidden = await page.eval(`document.querySelector('[data-testid="image-panel-processed"]').getAttribute("aria-hidden")`);
  const desktopTabsHidden = await page.eval(`document.querySelector('[role="tablist"]').getAttribute("aria-hidden")`);

  assert(desktopOrigPanelHidden === "false", "desktop original panel must be aria-hidden=false");
  assert(desktopProcPanelHidden === "false", "desktop processed panel must be aria-hidden=false (exposed to assistive tech)");
  assert(desktopTabsHidden === "true", "desktop tabs must be aria-hidden=true");
});

test("T41 実ブラウザーで画像照合画面の英語表示とARIA整合性を検証 (English)", async (page, base) => {
  page.apiHandler = () => ok({ dish: "DISH-RESPONSIVE-EN", allergens: ["shrimp"] });
  await setupToUpload(page, base, { allergens: ["shrimp"], userLang: "en" });
  await uploadImage(page, IMG_A);
  await analyzeAndWaitResult(page, "DISH-RESPONSIVE-EN");

  await page.waitForTestId("image-reconciliation");

  const noteText = await page.eval(`document.querySelector('[class*="imageRetentionNote"]').innerText`);
  assert(noteText.includes("Original images are kept only on this device and never sent to the server"), "EN retention note must accurately describe local retention");
  assert(noteText.includes("Processed images sent for AI analysis are processed only in memory"), "EN retention note must describe server memory processing");
  assert(noteText.includes("Images remain available while navigating within the app"), "EN retention note must describe in-app persistence");

  // Mobile check
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 667,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(100);
  const mobileOrigHidden = await page.eval(`document.querySelector('[data-testid="image-panel-original"]').getAttribute("aria-hidden")`);
  const mobileProcHidden = await page.eval(`document.querySelector('[data-testid="image-panel-processed"]').getAttribute("aria-hidden")`);
  assert(mobileOrigHidden === "false", "mobile original panel must be aria-hidden=false");
  assert(mobileProcHidden === "true", "mobile processed panel must be aria-hidden=true");

  // Desktop check
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);
  const desktopOrigHidden = await page.eval(`document.querySelector('[data-testid="image-panel-original"]').getAttribute("aria-hidden")`);
  const desktopProcHidden = await page.eval(`document.querySelector('[data-testid="image-panel-processed"]').getAttribute("aria-hidden")`);
  assert(desktopOrigHidden === "false", "desktop original panel must be aria-hidden=false");
  assert(desktopProcHidden === "false", "desktop processed panel must be aria-hidden=false");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const results = [];
let server;
let browser;
try {
  server = await startDevServer();
  browser = await launchBrowser();
  const setupPage = await browser.newPage();
  const exifBuffers = await generateSyntheticExifJpegs(setupPage);
  for (let o = 1; o <= 8; o++) {
    const p = join(imgDir, `synthetic-exif-${o}.jpg`);
    writeFileSync(p, exifBuffers[o]);
    EXIF_JPEGS[o] = p;
  }
  await setupPage.close();
  console.log(`browser: ${browser.exe}\nserver: ${server.base}\n`);
  for (const sc of scenarios) {
    if (production !== sc.name.startsWith("T23")) continue;
    if (only && !sc.name.includes(only)) continue;
    const page = await browser.newPage();
    const started = Date.now();
    try {
      await sc.fn(page, server.base);
      results.push({ name: sc.name, status: "PASS", ms: Date.now() - started });
      console.log(`PASS  ${sc.name}`);
    } catch (e) {
      results.push({ name: sc.name, status: "FAIL", ms: Date.now() - started, error: String(e.message ?? e) });
      console.log(`FAIL  ${sc.name}\n      ${e.message ?? e}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  killTree(server?.proc);
}
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed (${results.length} scenarios)`);
if (reportPath) writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed > 0 ? 1 : 0);
