/*
 * Captures UI/UX audit screenshots across viewports (1440px, 375px, 320px)
 * for Settings, Upload, Results, and Confirmation Card.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { killTree, launchBrowser, sleep } from "./cdp.mjs";

const outDir = process.argv[2] || process.env.SCREENSHOT_DIR || join(tmpdir(), "allergybridge_screenshots");
mkdirSync(outDir, { recursive: true });

// 200x150 solid PNG with proper CRC
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
function validChunk(type, data) {
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    validChunk("IHDR", ihdr),
    validChunk("IDAT", deflateSync(raw)),
    validChunk("IEND", Buffer.alloc(0)),
  ]);
}

const testImg = join(outDir, "test-menu.png");
writeFileSync(testImg, solidPng(300, 200, [60, 120, 220]));

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

async function startServer() {
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(port), "-H", "127.0.0.1"],
    {
      env: { ...process.env, MOCK_GEMINI: "true", AI_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + "/");
      if (r.status === 200) break;
    } catch {}
    await sleep(250);
  }
  return { proc, base };
}

async function run() {
  const server = await startServer();
  const browser = await launchBrowser();
  console.log(`Browser: ${browser.exe}`);
  console.log(`Server: ${server.base}`);

  const viewports = [
    { name: "desktop_1440", w: 1440, h: 900 },
    { name: "mobile_375", w: 375, h: 812 },
    { name: "mobile_320", w: 320, h: 640 },
  ];

  try {
    for (const vp of viewports) {
      console.log(`\n--- Capturing ${vp.name} ---`);
      const page = await browser.newPage();
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: 1,
        mobile: vp.w < 768,
      });

      // 1. Settings screen
      await page.goto(server.base + "/");
      await page.waitForTestId("settings-section", 30_000);
      await page.waitFor(
        `(() => { const el = ${page.sel("settings-section")}; return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")); })()`,
        { timeout: 30_000, message: "React hydration" },
      );

      const shotSettings = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `01_settings_${vp.name}.png`), Buffer.from(shotSettings.data, "base64"));
      console.log(`  Saved 01_settings_${vp.name}.png`);

      // Toggle allergens (Egg & Milk)
      await page.clickSelector('[data-testid="allergen-option-egg"] input');
      await page.clickSelector('[data-testid="allergen-option-milk"] input');
      await page.waitFor(
        `(() => {
          const egg = document.querySelector('[data-testid="allergen-option-egg"] input');
          const milk = document.querySelector('[data-testid="allergen-option-milk"] input');
          return !!egg && egg.checked && !!milk && milk.checked;
        })()`,
        { timeout: 5000, message: "allergen checkboxes checked" },
      );

      // 2. Upload screen
      await page.click("proceed-to-upload-btn");
      await page.waitForTestId("upload-section");

      // Upload image
      await page.setInputFiles('[data-testid="upload-file-input"]', [testImg]);
      await page.waitFor(
        `(() => {
          const img = ${page.sel("uploaded-menu-preview-img")};
          const status = ${page.sel("image-processing-status")};
          return !!img && !status && img.complete && img.naturalWidth > 0;
        })()`,
        { timeout: 15000, message: "processed image preview decoded and rendered" },
      );

      const shotUpload = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `02_upload_${vp.name}.png`), Buffer.from(shotUpload.data, "base64"));
      console.log(`  Saved 02_upload_${vp.name}.png`);

      // 3. Results screen
      await page.click("analyze-menu-btn");
      await page.waitForTestId("results-section");
      await page.waitFor(
        `(() => {
          const btn = ${page.sel("results-to-card-btn")};
          return !!btn && !btn.disabled;
        })()`,
        { timeout: 10000, message: "results action buttons ready" },
      );

      const shotResults = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `03_results_${vp.name}.png`), Buffer.from(shotResults.data, "base64"));
      console.log(`  Saved 03_results_${vp.name}.png`);

      // 4. Confirm card screen
      await page.click("results-to-card-btn");
      await page.waitForTestId("confirm-card-placeholder-section");
      await page.waitFor(
        `(() => {
          const title = document.getElementById("confirm-card-section-title");
          return !!title && title.offsetParent !== null;
        })()`,
        { timeout: 10000, message: "confirmation card title rendered" },
      );

      const shotCard = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `04_card_${vp.name}.png`), Buffer.from(shotCard.data, "base64"));
      console.log(`  Saved 04_card_${vp.name}.png`);

      await page.close();
    }
    console.log("\nAll baseline screenshots captured successfully!");
  } finally {
    await browser?.close();
    killTree(server?.proc);
  }
}

run().catch((err) => {
  console.error("Screenshot runner error:", err);
  process.exit(1);
});
