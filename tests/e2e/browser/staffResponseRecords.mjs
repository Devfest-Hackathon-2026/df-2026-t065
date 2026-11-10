/* SYNTHETIC TEST DATA. Run against a locally started app; never calls the analysis API.
 * AB_TEST_BASE=http://127.0.0.1:3000 node tests/e2e/browser/staffResponseRecords.mjs
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./cdp.mjs";
import { readSnapshot, writeRawSnapshot, assertEmpty } from "./responseStore.mjs";
const base = process.env.AB_TEST_BASE ?? "http://127.0.0.1:3000";
const browser = await launchBrowser();
let page = await browser.newPage();
const q = "Q_ALLERGEN_SHRIMP";
async function openCard() {
  await page.waitForTestId("settings-section");
  await page.waitFor(`Object.keys(${page.sel("settings-section")}).some(k => k.startsWith('__reactProps$'))`);
  // Keep the check and click in one browser task: settings restoration may finish
  // between separate CDP calls and otherwise toggle an already-restored checkbox off.
  await page.eval(`(() => {
    const input = document.querySelector('[data-testid="allergen-option-shrimp"] input');
    if (!input.checked) input.click();
  })()`);
  await page.waitFor(`!${page.sel("go-to-card-directly-btn")}.disabled`);
  await page.click("go-to-card-directly-btn");
  await page.waitForTestId("staff-records");
  await page.waitFor(`!${page.sel("record-save-consent")}.disabled`);
}
async function statusIncludes(text) {
  await page.waitFor(`${page.sel("record-storage-status")}.textContent.includes(${JSON.stringify(text)})`);
}
async function checkUpgradeNotice(lang) {
  const viewport = await page.eval("({ width: innerWidth, height: innerHeight })");
  const text = await page.eval(`${page.sel("record-upgrade-notice")}.textContent`);
  for (const term of lang === "ja"
    ? ["タブをすべて閉じ", "再読み込み", "移行せず破棄", "再入力", "同意", "再び書き込む", "止めることはできません"]
    : ["close every tab", "reload this page", "discarded, not migrated", "Enter your answers again", "fresh consent", "may write to localStorage again", "cannot stop that older code"]) {
    assert(text.includes(term), `upgrade notice explains ${term}`);
  }
  for (const width of [320, 375, 1440]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await page.eval(`${page.sel("record-upgrade-notice")}.scrollIntoView({block:'center'})`);
    assert(await page.eval(`(() => {const p=${page.sel("record-upgrade-notice")};const r=p.getBoundingClientRect();const style=getComputedStyle(p);return p.getAttribute('role')==='note' && style.display!=='none' && style.visibility!=='hidden' && parseFloat(style.fontSize)>=16 && r.height>0 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth;})()`), `${lang} ${width}px notice visible, readable and contained`);
  }
  await page.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 600 });
  console.log(`PASS: ${lang} upgrade notice at 320/375/1440px`);
}
try {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.goto(base);
  await openCard();
  await checkUpgradeNotice("ja");
  assert(await page.isDisabled("record-save"));
  assert(await page.isDisabled("record-restore"));
  await page.click(`record-${q}-yes`);
  await assertEmpty(page);
  await page.click("staff-answer-btn-ANS_DOES_NOT_CONTAIN");
  assert.equal(await page.eval(`${page.sel(`record-${q}-yes`)}.checked`), true);
  await page.click("record-save-consent");
  await page.click("record-save");
  await statusIncludes("保存しました");
  const saved = await readSnapshot(page);
  await page.click(`record-${q}-unknown`);
  assert.equal(await readSnapshot(page), saved, "no automatic writes after consent");
  await page.reload();
  await openCard();
  assert.equal(await page.eval(`${page.sel(`record-${q}-yes`)}.checked`), false, "no automatic restoration");
  await page.waitFor(`!${page.sel("record-restore-consent")}.disabled`);
  await page.click("record-restore-consent");
  await page.click("record-restore");
  await statusIncludes("復元しました");
  assert.equal(await page.eval(`${page.sel(`record-${q}-yes`)}.checked`), true);
  // Native keyboard Space can select an answer; Tab leaves a visible focus target.
  await page.eval(`${page.sel(`record-${q}-no`)}.focus()`);
  await page.press("Space");
  assert.equal(await page.eval(`${page.sel(`record-${q}-no`)}.checked`), true);
  await page.press("Tab");
  assert(await page.eval("document.activeElement !== document.body"));
  assert(await page.eval(`${page.sel(`record-${q}-yes`)}.closest('label').getBoundingClientRect().height >= 48`));
  assert(await page.eval("document.documentElement.scrollWidth <= innerWidth"));
  // A changed question memo remounts all records and resets both permissions.
  await page.click(`edit-phrase-btn-${q}`);
  await page.eval(`(() => {
    const el = ${page.sel(`edit-user-textarea-${q}`)};
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'SYNTHETIC TEST DATA');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(`!${page.sel(`record-${q}-no`)}.checked`);
  assert(await page.isDisabled("record-save"));
  await page.waitFor(`!${page.sel("record-restore-consent")}.disabled`);
  await page.click("record-restore-consent");
  await page.click("record-restore");
  await statusIncludes("破棄しました");
  await assertEmpty(page);
  await page.click(`record-${q}-unknown`);
  await page.click(`record-clear-${q}`);
  assert.equal(await page.eval(`${page.sel(`record-${q}-unknown`)}.checked`), false);
  await page.click(`record-${q}-unknown`);
  await page.click("record-delete-all");
  await statusIncludes("削除しました");
  // Throwing localStorage getter must leave all card actions usable.
  await page.eval(`void Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } })`);
  await page.click(`record-${q}-no`);
  await page.click("record-save-consent");
  await page.click("record-save");
  await statusIncludes("利用できません");
  await page.click("record-delete-all");
  await statusIncludes("削除は確認できません");
  assert.equal(await page.eval(`${page.sel(`record-${q}-no`)}.checked`), false);
  assert(await page.exists(`phrase-card-${q}`));
  assert.equal(page.apiRequests.length, 0);
  assert.equal(page.consoleErrors.length, 0, page.consoleErrors.join('\n'));
  await page.close();
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForTestId("settings-section");
  await page.click("user-lang-btn-en");
  await openCard();
  await checkUpgradeNotice("en");
  assert((await page.bodyText()).includes("Your record of staff responses"));
  assert((await page.bodyText()).includes("Not recorded"));
  await page.click(`record-${q}-no`);
  await page.click("record-save-consent");
  await page.click("record-save");
  await statusIncludes("Answers saved");
  await page.click("card-back-to-settings-btn");
  await page.waitForTestId("settings-section");
  await page.clickSelector('[data-testid="allergen-option-egg"] input');
  await page.click("go-to-card-directly-btn");
  await page.waitForTestId("staff-records");
  await page.waitFor(`!${page.sel("record-save-consent")}.disabled`);
  assert.equal(await page.eval(`${page.sel(`record-${q}-no`)}.checked`), false);
  await page.waitFor(`!${page.sel("record-restore-consent")}.disabled`);
  await page.click("record-restore-consent");
  await page.click("record-restore");
  await statusIncludes("discarded");
  await writeRawSnapshot(page, '{broken');
  await page.click("record-restore");
  await statusIncludes("discarded");
  await assertEmpty(page);
  assert.equal(page.apiRequests.length, 0);
  assert.equal(page.consoleErrors.length, 0, page.consoleErrors.join('\n'));
  console.log("PASS: mobile records, consent, explicit restore, no autosave, context reset, keyboard, delete, storage failure, no API calls or hydration errors");
} finally {
  await page.close();
  await browser.close();
}
