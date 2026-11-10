/* SYNTHETIC TEST DATA. Real same-origin tabs, native Web Locks, deterministic hash/lock gates.
 * No Playwright dependency is added. Uses the existing CDP driver.
 * AB_TEST_BASE=http://127.0.0.1:3000 node tests/e2e/browser/staffResponseConcurrency.mjs
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { launchBrowser, Page } from "./cdp.mjs";
import { readState, readSnapshot, assertEmpty } from "./responseStore.mjs";
const base = process.env.AB_TEST_BASE ?? "http://127.0.0.1:3000";
const lockName = "allergy_bridge_staff_responses_v2";
const q = "Q_ALLERGEN_SHRIMP";
const browser = await launchBrowser();
const inject = `(() => {
  const state = window.__responseRace = { delayEvents: true, events: [], pauseHash: false, hashPending: 0, hashReleases: [], holdLock: false, lockEntered: false };
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  const wrapped = new WeakMap();
  window.addEventListener = (type, listener, options) => {
    if (type !== 'storage') return add(type, listener, options);
    const proxy = event => { if (state.delayEvents) state.events.push(() => listener(event)); else listener(event); };
    wrapped.set(listener, proxy); add(type, proxy, options);
  };
  window.removeEventListener = (type, listener, options) => remove(type, wrapped.get(listener) || listener, options);
  state.deliver = () => { state.events.splice(0).forEach(fn => fn()); };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = async (...args) => {
    const result = await digest(...args);
    if (state.pauseHash) { state.hashPending++; await new Promise(resolve => state.hashReleases.push(resolve)); state.hashPending--; }
    return result;
  };
  state.resumeHash = () => { state.pauseHash = false; state.hashReleases.splice(0).forEach(resolve => resolve()); };
  const request = navigator.locks.request.bind(navigator.locks);
  navigator.locks.request = (name, options, callback) => request(name, options, async lock => {
    if (name === '${lockName}' && state.holdLock) {
      state.holdLock = false; state.lockEntered = true;
      await new Promise(resolve => { state.resumeLock = resolve; });
    }
    return callback(lock);
  });
})();`;
async function sharedTab(first) {
  if (!first) return browser.newPage();
  const { targetId } = await browser.conn.send("Target.createTarget", { url: "about:blank", browserContextId: first.browserContextId });
  const { sessionId } = await browser.conn.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(browser.conn, sessionId, targetId, first.browserContextId);
  await page.init(); return page;
}
async function open(page) {
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  await page.goto(base);
  await card(page);
}
async function card(page) {
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
  await ready(page);
}
const ready = page => page.waitFor(`!${page.sel("record-save-consent")}.disabled`);
const status = async (page, text) => {
  try { await page.waitFor(`${page.sel("record-storage-status")}.textContent.includes(${JSON.stringify(text)})`); }
  catch { throw new Error(`Expected status ${text}; observed ${await page.eval(`${page.sel("record-storage-status")}?.textContent`)}`); }
};
const empty = assertEmpty;
async function agreeSave(page, value = "yes") {
  await ready(page);
  await page.click(`record-${q}-${value}`);
  if (!(await page.eval(`${page.sel("record-save-consent")}.checked`))) await page.click("record-save-consent");
  await page.click("record-save");
}
const results=[];
async function probe(page) {
  if(page.fixtureClosed)return {closed:true};
  const state=await readState(page);
  const ui=await page.eval(`(() => {const text=${page.sel('record-storage-status')}.textContent;return {consent:${page.sel('record-save-consent')}.checked,restoreConsent:${page.sel('record-restore-consent')}.checked,selected:document.querySelectorAll('[data-testid="staff-records"] input[type="radio"]:checked').length,status:text.includes('失効')?'invalidated':text.includes('保存しました')?'saved':text.includes('削除しました')?'deleted':text.includes('ありません')?'missing':'other'}})()`);
  const snapshotPresent=state.snapshot!==null;
  const generationMatches=!snapshotPresent||JSON.parse(state.snapshot).epoch===state.epoch;
  assert(generationMatches,'snapshot belongs to authoritative generation');
  if(['invalidated','deleted'].includes(ui.status))assert(!ui.consent&&!ui.restoreConsent&&ui.selected===0,'reset clears answers and confirmations');
  if(ui.status==='missing')assert(ui.selected===0,'missing data never applies answers');
  return {generationPresent:typeof state.epoch==='string',snapshotPresent,generationMatches,...ui};
}
function report() {if(process.env.AB_RACE_REPORT)writeFileSync(process.env.AB_RACE_REPORT,JSON.stringify({results},null,2));}
async function test(name, fn) {
  if (process.env.AB_RACE_ONLY && !name.includes(process.env.AB_RACE_ONLY)) return;
  for(let round=1;round<=Number(process.env.AB_RACE_ROUNDS??1);round++) {
    const a=await sharedTab();let b;
    try {
      await open(a);b=await sharedTab(a);await open(b);
      await fn(a,b);
      for(const page of [a,b]){assert.equal(page.apiRequests.length,0);assert.equal(page.consoleErrors.length,0,'no browser exceptions');}
      results.push({name,round,status:'PASS',a:await probe(a),b:await probe(b)});report();console.log(`PASS ${name} (${round})`);
    }catch(error){results.push({name,round,status:'FAIL',kind:error.code==='ERR_ASSERTION'?'assertion':'error'});report();throw error;}
    finally{await a.close();await b?.close();}
  }
}

try {
  await test("保存待機→別タブ削除→storage通知なしで再開／リロード後非復活／再同意の新規保存", async (a, b) => {
    await agreeSave(a); await status(a, "保存しました");
    await a.click(`record-${q}-no`);
    await a.eval("window.__responseRace.pauseHash = true");
    await a.click("record-save"); await a.waitFor("window.__responseRace.hashPending === 1");
    await b.click("record-delete-all"); await status(b, "削除しました"); await empty(b);
    await a.eval("window.__responseRace.resumeHash()");
    await a.waitFor(`!${a.sel("record-save-consent")}.disabled`); await empty(a); await a.waitFor(`!${a.sel("record-save-consent")}.disabled`); await empty(a); await status(a, "失効");
    assert.equal(await a.eval(`${a.sel("record-save-consent")}.checked || ${a.sel("record-restore-consent")}.checked`), false);
    assert.equal(await a.eval(`${a.sel(`record-${q}-no`)}.checked`), false);
    await a.reload(); await card(a);
    await a.click("record-restore-consent"); await a.click("record-restore"); await status(a, "ありません");
    await agreeSave(a, "unknown"); await status(a, "保存しました");
    assert.equal(JSON.parse(await readSnapshot(a)).answers[0].answer, "unknown");
  });
  await test("復元待機→別タブ削除→復元結果を適用しない", async (a, b) => {
    await agreeSave(a); await status(a, "保存しました");
    await a.click("record-restore-consent"); await a.eval("window.__responseRace.pauseHash = true");
    await a.click("record-restore"); await a.waitFor("window.__responseRace.hashPending === 1");
    await b.click("record-delete-all"); await status(b, "削除しました");
    await a.eval("window.__responseRace.resumeHash()"); await a.waitFor(`!${a.sel("record-save-consent")}.disabled`); await empty(a); await status(a, "失効");
    assert.equal(await a.eval(`${a.sel(`record-${q}-yes`)}.checked`), false); await empty(a);
  });
  await test("削除が排他区間内で待機→別タブ保存がロック待機→削除優先", async (a, b) => {
    await agreeSave(a); await status(a, "保存しました");
    const beforeEpoch = (await readState(a)).epoch;
    // D: even an obsolete localStorage view must never authorize the new store.
    await a.eval(`(() => { const get=Storage.prototype.getItem; Storage.prototype.getItem=function(key) { return this===localStorage && key==='allergy_bridge_staff_response_epoch' ? '00000000-0000-4000-8000-000000000000' : get.call(this,key); }; })()`);
    await b.eval("window.__responseRace.holdLock = true"); await b.click("record-delete-all");
    await b.waitFor("window.__responseRace.lockEntered");
    await a.click(`record-${q}-no`); await a.click("record-save");
    await a.waitFor(`navigator.locks.query().then(s => s.pending.some(l => l.name === '${lockName}'))`);
    // While deletion holds the native lock, a competing save cannot write.
    assert.equal(JSON.parse(await readSnapshot(a)).answers[0].answer, "yes");
    await b.eval("window.__responseRace.resumeLock()"); await status(b, "削除しました");
    await a.waitFor(`!${a.sel("record-save-consent")}.disabled`); await empty(a); await status(a, "失効");
    assert((await readState(a)).epoch !== beforeEpoch, 'deletion rotates the authoritative generation');
    assert.equal(await a.eval(`${a.sel("record-save-consent")}.checked || ${a.sel("record-restore-consent")}.checked || ${a.sel(`record-${q}-no`)}.checked`), false);
    const third = await sharedTab(a);
    try {
      await open(third); await empty(third);
      await third.click('record-restore-consent'); await third.click('record-restore'); await status(third,'ありません');
      assert.equal(await third.eval(`${third.sel(`record-${q}-yes`)}.checked || ${third.sel(`record-${q}-no`)}.checked`),false);
    } finally { await third.close(); }
    await a.click('record-save'); await empty(a); // No reuse of old consent.
  });
  await test("複数タブ同時保存／連続保存削除／遅延storage通知で保存済み表示と同意を失効", async (a, b) => {
    await Promise.all([agreeSave(a, "yes"), agreeSave(b, "unknown")]);
    await Promise.all([status(a, "保存しました"), status(b, "保存しました")]);
    assert(["yes", "unknown"].includes(JSON.parse(await readSnapshot(a)).answers[0].answer));
    await b.click("record-delete-all"); await status(b, "削除しました");
    assert((await a.eval(`${a.sel("record-storage-status")}.textContent`)).includes("保存しました"));
    await a.waitFor("window.__responseRace.events.length > 0");
    await a.eval("window.__responseRace.deliver()"); await a.waitFor(`!${a.sel("record-save-consent")}.disabled`); await empty(a); await status(a, "失効");
    assert.equal(await a.eval(`${a.sel("record-save-consent")}.checked`), false);
    for (let i = 0; i < 3; i++) {
      await agreeSave(a, "no"); await status(a, "保存しました");
      await b.click("record-delete-all"); await status(b, "削除しました"); await empty(b);
      await a.waitFor("window.__responseRace.events.length > 0");
      await a.eval("window.__responseRace.deliver()"); await status(a, "失効");
    }
  });
  await test("B: 削除のロック待機中に保存要求、第三タブの排他ゲートで順序を固定", async (a,b) => {
    await agreeSave(a); await status(a,'保存しました');
    const before=(await readState(a)).epoch;
    const c=await sharedTab(a);
    try {
      await open(c);
      await c.eval(`void navigator.locks.request('${lockName}',{mode:'exclusive'},async()=>{window.outerHeld=true;await new Promise(resolve=>{window.outerRelease=resolve})})`);
      await c.waitFor('window.outerHeld === true');
      await b.click('record-delete-all');
      await b.waitFor(`navigator.locks.query().then(s=>s.pending.filter(l=>l.name==='${lockName}').length===1)`);
      await a.click(`record-${q}-no`);await a.click('record-save');
      await a.waitFor(`navigator.locks.query().then(s=>s.pending.filter(l=>l.name==='${lockName}').length===2)`);
      await c.eval('window.outerRelease()');await status(b,'削除しました');
      await a.waitFor(`!${a.sel('record-save-consent')}.disabled`);
      await empty(a);await empty(b);await empty(c);await status(a,'失効');
      assert((await readState(c)).epoch!==before,'generation changes atomically');
      assert.equal(await a.eval(`${a.sel('record-save-consent')}.checked || ${a.sel('record-restore-consent')}.checked || ${a.sel(`record-${q}-no`)}.checked`),false);
      await c.click('record-restore-consent');await c.click('record-restore');await status(c,'失効');
      assert.equal(await c.eval(`${c.sel('record-save-consent')}.checked || ${c.sel('record-restore-consent')}.checked`),false);
      await c.click('record-restore-consent');await c.click('record-restore');await status(c,'ありません');
    } finally {await c.close();}
  });
  await test("E2: 削除待機中の遅延通知でも明示的な削除を取り消さない",async(a,b)=>{
    await agreeSave(a);await status(a,'保存しました');await b.waitFor('window.__responseRace.events.length>0');
    await b.eval('window.__responseRace.holdLock=true');await b.click('record-delete-all');await b.waitFor('window.__responseRace.lockEntered');
    await b.eval('window.__responseRace.deliver()');await b.eval('window.__responseRace.resumeLock()');
    await status(b,'削除しました');await empty(a);await empty(b);
    assert.equal(await b.eval(`${b.sel('record-save-consent')}.checked || ${b.sel('record-restore-consent')}.checked`),false);
  });
  await test("移行: 旧localStorage回答を読み込まず破棄、新規同意だけで保存", async (a,b) => {
    for (const version of [1,2]) {
      await a.eval(`localStorage.setItem('allergy_bridge_staff_responses',JSON.stringify({version:${version},source:'user_recorded_staff_response',epoch:'00000000-0000-4000-8000-000000000000',contextHash:'a'.repeat(64),answers:[{questionId:'${q}',answer:'yes'}]}))`);
      const c=await sharedTab(b);
      try {
        await open(c);await empty(c);
        assert.equal(await c.eval(`${c.sel('record-save-consent')}.checked || ${c.sel('record-restore-consent')}.checked || ${c.sel(`record-${q}-yes`)}.checked`),false);
        await c.click('record-restore-consent');await c.click('record-restore');await status(c,'ありません');
        await agreeSave(c,'unknown');await status(c,'保存しました');
        const state=await readState(c);assert(JSON.parse(state.snapshot).epoch===state.epoch,'snapshot belongs to current generation');
        await c.click('record-delete-all');await status(c,'削除しました');await empty(c);
      }finally{await c.close();}
    }
  });
  await test("K: hash待機中のタブを閉じてもデータを再保存しない",async(a,b)=>{
    await agreeSave(a);await status(a,'保存しました');
    await a.eval('window.__responseRace.pauseHash=true');await a.click('record-save');await a.waitFor('window.__responseRace.hashPending===1');
    await a.close();a.fixtureClosed=true;await b.click('record-delete-all');await status(b,'削除しました');await empty(b);
    const c=await sharedTab(b);try{await open(c);await empty(c);await c.click('record-restore-consent');await c.click('record-restore');await status(c,'ありません');}finally{await c.close();}
  });
  await test("K2: native IDBのcommit前にタブを閉じるとtransactionを中止",async(a,b)=>{
    await agreeSave(a);await status(a,'保存しました');await a.click(`record-${q}-no`);
    await a.eval(`(() => {const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);if(this.name==='records'&&window.holdResponseCommit){const store=this;const keep=()=>{store.get('current').onsuccess=()=>{if(window.holdResponseCommit)keep()}};keep();window.responseCommitHeld=true;}return result};window.holdResponseCommit=true;})()`);
    await a.click('record-save');await a.waitFor('window.responseCommitHeld===true');
    assert(await a.isDisabled('record-save'),'no success before transaction completion');
    await a.close();a.fixtureClosed=true;await b.click('record-delete-all');await status(b,'削除しました');await empty(b);
    const c=await sharedTab(b);try{await open(c);await empty(c);await c.click('record-restore-consent');await c.click('record-restore');await status(c,'ありません');}finally{await c.close();}
  });
  await test("L: IDB putの失敗・transaction abortで保存成功も削除成功も表示しない",async(a,b)=>{
    await agreeSave(a);await status(a,'保存しました');const before=await readState(a);
    await a.eval(`(() => {const get=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(window.failNextResponseGet&&this.name==='records'){window.failNextResponseGet=false;throw new DOMException('synthetic read failure','UnknownError')}return get.apply(this,args)};window.failNextResponseGet=true;})()`);
    await a.click('record-save');await status(a,'利用できません');
    assert((await readState(b)).snapshot===before.snapshot,'read failure never writes or reports success');

    await a.eval(`(() => {const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(window.failNextResponsePut&&this.name==='records'){window.failNextResponsePut=false;throw new DOMException('synthetic quota','QuotaExceededError')}return put.apply(this,args)};window.failNextResponsePut=true;})()`);
    await a.click('record-save');await status(a,'利用できません');
    assert((await readState(b)).snapshot===before.snapshot,'abort preserves committed record');
    await a.eval('window.failNextResponsePut=true');await a.click('record-delete-all');await status(a,'削除は確認できません');
    assert((await readState(b)).epoch===before.epoch,'no partial generation commit');
    assert.equal(await a.eval(`${a.sel('record-save-consent')}.checked || ${a.sel('record-restore-consent')}.checked`),false);
    await a.click('record-delete-all');await status(a,'削除しました');await empty(b);
  });
  await test("Web Locksなしはメモリ内利用だけ／削除成功の誤表示なし", async (a) => {
    await a.send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })" });
    await a.reload();
    await a.waitForTestId("settings-section");
    await a.waitFor(`document.querySelector('[data-testid="allergen-option-shrimp"] input').checked`);
    await a.click("go-to-card-directly-btn");
    await status(a, "排他制御を利用できない");
    await a.click(`record-${q}-yes`);
    assert(await a.isDisabled("record-save")); assert(await a.isDisabled("record-restore"));
    await a.click("record-delete-all"); await status(a, "保証できません");
    assert(await a.exists(`phrase-card-${q}`)); await empty(a);
  });
} finally { await browser.close(); }
