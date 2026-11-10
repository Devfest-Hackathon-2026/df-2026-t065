/* SYNTHETIC TEST DATA. No analysis API calls.
 * Start the local app, then:
 * AB_TEST_BASE=http://127.0.0.1:3000 node tests/e2e/browser/uiAccessibility.mjs
 * Uses the existing Chromium/CDP harness; no new packages.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./cdp.mjs";

const base = process.env.AB_TEST_BASE ?? "http://127.0.0.1:3000";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/?$/, "local app only");
const browser = await launchBrowser();
const phrase = "Q_ALLERGEN_SHRIMP";
const testSelector = (id) => `[data-testid="${id}"]`;

async function tabTo(page, selector) {
  for (let i = 0; i < 100; i++) {
    if (await page.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
    await page.press("Tab");
  }
  throw new Error(`Keyboard cannot reach ${selector}`);
}

async function activate(page, id) {
  await tabTo(page, testSelector(id));
  await page.press("Enter");
}

async function replaceText(page, text) {
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  if (text) await page.send("Input.insertText", { text });
}

async function checkLayout(page) {
  assert(await page.eval("document.documentElement.scrollWidth <= innerWidth"), "no horizontal overflow");
  const small = await page.eval(`Array.from(document.querySelectorAll('button')).filter(e => e.getBoundingClientRect().height > 0 && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44)).map(e => e.textContent)`);
  assert.deepEqual(small, [], "visible buttons provide at least 44 x 44 CSS px");
}

try {
  for (const width of [1440, 375, 320]) {
    for (const lang of ["ja", "en"]) {
      const page = await browser.newPage();
      // A mistaken analysis action is fulfilled locally, never forwarded.
      page.apiHandler = () => ({ status: 503, body: { requestId: "ui-test", error: { code: "AI_DISABLED", retryable: false } } });
      try {
        await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await page.goto(base);
        await page.waitForTestId("settings-section");
        await page.waitFor(`Object.keys(${page.sel("settings-section")}).some(k => k.startsWith('__reactProps$'))`);
        assert.equal(await page.eval("document.activeElement.tagName"), "BODY", "no initial autofocus");
        if (lang === "en") await activate(page, "user-lang-btn-en");
        await tabTo(page, '[data-testid="allergen-option-shrimp"] input');
        await page.press("Space");
        await checkLayout(page);
        assert.equal(await page.eval(`getComputedStyle(${page.sel("fixed-scrolling-bg")}).animationName`), "none");
        assert.equal(await page.eval(`getComputedStyle(${page.sel("user-lang-btn-ja")}).transitionDuration`), "0s");

        // Keyboard activation from the bottom of Settings reproduces the original scroll bug.
        await tabTo(page, testSelector("go-to-card-directly-btn"));
        assert(await page.eval("scrollY > 0"));
        await page.press("Enter");
        await page.waitFor('document.activeElement.id === "confirm-card-section-title" && scrollY === 0');
        assert.equal(await page.eval(`${page.sel("confirm-card-placeholder-section")}.dataset.cardMode`), "standalone");
        assert(await page.exists("persistent-safety-banner"));
        await checkLayout(page);

        await activate(page, `edit-phrase-btn-${phrase}`);
        const store = `edit-store-textarea-${phrase}`;
        await tabTo(page, testSelector(store));
        assert(await page.eval(`parseFloat(getComputedStyle(${page.sel(store)}).fontSize) >= 16`));
        await replaceText(page, "");
        await page.waitFor(`${page.sel(store)}.getAttribute('aria-invalid') === 'true'`);
        const error = await page.eval(`(() => { const input = ${page.sel(store)}; return input.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id)?.textContent); })()`);
        assert(error.every(Boolean), "all descriptions resolve to visible help/error text");
        assert.match(error.at(-1), lang === "ja" ? /入力エラー/ : /Input Error/);
        assert.equal(await page.activeTestId(), store, "validation does not steal focus");
        assert(await page.isDisabled("toggle-staff-presentation-btn"), "invalid edit still blocks presentation");

        await replaceText(page, "SYNTHETIC TEST DATA: extra question");
        await page.waitFor(`${page.sel(store)}.getAttribute('aria-invalid') === 'false'`);
        assert(!(await page.eval(`${page.sel(store)}.getAttribute('aria-describedby').includes('edit-store-error')`)));
        // Closing/reopening the editor retains the draft; no new cancel/discard semantics.
        await activate(page, `edit-phrase-btn-${phrase}`);
        await activate(page, `edit-phrase-btn-${phrase}`);
        assert.equal(await page.eval(`${page.sel(store)}.value`), "SYNTHETIC TEST DATA: extra question");
        await activate(page, "toggle-staff-presentation-btn");
        assert.equal(await page.eval(`${page.sel("confirm-card-placeholder-section")}.dataset.presentationMode`), "staff_presentation");
        await activate(page, "toggle-staff-presentation-btn");
        assert.equal(await page.eval(`${page.sel(store)}.value`), "SYNTHETIC TEST DATA: extra question");

        // A same-step click must not reset the card or move focus to its heading.
        await activate(page, "step-nav-confirmCard");
        assert.equal(await page.activeTestId(), "step-nav-confirmCard");
        assert.equal(await page.eval(`${page.sel(store)}.value`), "SYNTHETIC TEST DATA: extra question");
        await activate(page, `reset-phrase-btn-${phrase}`);
        await page.waitFor(`!${page.sel(`phrase-user-memo-box-${phrase}`)}`);
        assert.equal(await page.eval(`${page.sel(store)}.value`), await page.eval(`${page.sel(`phrase-store-text-${phrase}`)}.textContent`));
        assert.equal(await page.eval(`${page.sel(store)}.getAttribute('aria-invalid')`), "false");
        await activate(page, "specs-modal-trigger");
        assert.equal(await page.activeTestId(), "specs-modal-close-btn");
        await page.press("Tab");
        assert.equal(await page.activeTestId(), "specs-modal-close-btn");
        await page.press("Escape");
        await page.waitFor(`${page.sel("specs-modal-trigger")} === document.activeElement`);

        // Actual hit-testing, separately from the visual text/outline size.
        await page.eval(`${page.sel("specs-modal-trigger")}.scrollIntoView({block:'center'})`);
        assert(await page.eval(`(() => { const e = ${page.sel("specs-modal-trigger")}; const r = e.getBoundingClientRect(); return [[r.width/2,2],[r.width/2,r.height-2],[2,r.height/2],[r.width-2,r.height/2]].every(([x,y]) => e.contains(document.elementFromPoint(r.left+x,r.top+y))); })()`), "button edge midpoints are clickable and unobscured (rounded corners excluded)");
        await checkLayout(page);
        await activate(page, "step-nav-upload");
        await activate(page, "step-nav-confirmCard");
        await page.waitFor('document.activeElement.id === "confirm-card-section-title" && scrollY === 0');
        assert.equal(page.apiRequests.length, 0);
        assert.deepEqual(page.consoleErrors, []);
        console.log(`PASS ${width}px ${lang}: keyboard, explicit card focus/scroll, reduced motion, hit areas, validation, editor, presentation, modal`);
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
