/*
 * Minimal, dependency-free Chrome DevTools Protocol (CDP) client for browser E2E tests.
 *
 * Why not Playwright: adding a dependency needs both developers' agreement (AGENTS.md §2/§4).
 * This uses only Node.js built-ins (child_process, fs, global WebSocket) and a locally
 * installed Chrome / Edge. It is NOT part of `npm run verify` / CI; run it manually:
 *   node tests/e2e/browser/run.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findBrowser() {
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome/Edge found. Set CHROME_PATH.");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, fn) {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, (this.listeners.get(method) ?? []).filter((f) => f !== fn));
  }
}

export async function launchBrowser() {
  const exe = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), "ab-e2e-"));
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(userDataDir, "DevToolsActivePort");
  const started = Date.now();
  while (!existsSync(portFile)) {
    if (Date.now() - started > 20_000) {
      killTree(proc);
      throw new Error("Browser did not start (DevToolsActivePort missing)");
    }
    await sleep(100);
  }
  let lines = [];
  while (lines.length < 2) {
    lines = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    if (lines.length < 2) await sleep(50);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const conn = new CdpConnection(ws);
  return {
    exe,
    conn,
    async newPage() {
      const { browserContextId } = await conn.send("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await conn.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(conn, sessionId, targetId, browserContextId);
      await page.init();
      return page;
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      killTree(proc);
      await sleep(300);
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* the browser may still hold files on Windows; harmless temp dir */
      }
    },
  };
}

const KEYS = {
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
};

export class Page {
  constructor(conn, sessionId, targetId, browserContextId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.browserContextId = browserContextId;
    /** Stub handler for /api/analyze-menu: (info, index) => {status, body, delayMs} | "continue" */
    this.apiHandler = () => "continue";
    this.apiRequests = [];
    this.requestedUrls = [];
    this.fileChooserEvents = [];
    this.consoleErrors = [];
  }
  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }
  on(method, fn) {
    return this.conn.on(method, (params, sid) => {
      if (sid === this.sessionId) fn(params);
    });
  }
  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("Network.enable");
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/analyze-menu*", requestStage: "Request" }] });
    this.on("Network.requestWillBeSent", (p) => this.requestedUrls.push(p.request.url));
    this.on("Page.fileChooserOpened", (p) => this.fileChooserEvents.push(p));
    this.on("Runtime.exceptionThrown", (p) =>
      this.consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception"),
    );
    this.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") {
        const text = (p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
        this.consoleErrors.push(text || "console.error");
      }
    });
    this.on("Fetch.requestPaused", (p) => {
      const index = this.apiRequests.length;
      const info = {
        index,
        url: p.request.url,
        method: p.request.method,
        headers: p.request.headers,
        aborted: false,
        fulfilledAt: null,
      };
      this.apiRequests.push(info);
      this.handlePaused(p, info).catch(() => {
        info.aborted = true;
      });
    });
  }
  async handlePaused(p, info) {
    const decision = await this.apiHandler(info, info.index);
    if (decision === "continue") {
      await this.send("Fetch.continueRequest", { requestId: p.requestId });
      return;
    }
    if (decision.delayMs) await sleep(decision.delayMs);
    const body = Buffer.from(JSON.stringify(decision.body)).toString("base64");
    await this.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: decision.status,
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "cache-control", value: "no-store" },
      ],
      body,
    });
    info.fulfilledAt = Date.now();
  }
  async goto(url) {
    const loaded = new Promise((resolve) => {
      const off = this.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }
  async reload() {
    const loaded = new Promise((resolve) => {
      const off = this.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
    });
    await this.send("Page.reload", {});
    await loaded;
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }
  async waitFor(expression, { timeout = 10_000, message } = {}) {
    const started = Date.now();
    for (;;) {
      let v;
      try {
        v = await this.eval(expression);
      } catch {
        v = false;
      }
      if (v) return v;
      if (Date.now() - started > timeout) throw new Error(`Timeout waiting for: ${message ?? expression}`);
      await sleep(50);
    }
  }
  sel(testid) {
    return `document.querySelector('[data-testid="${testid}"]')`;
  }
  exists(testid) {
    return this.eval(`!!${this.sel(testid)}`);
  }
  waitForTestId(testid, timeout) {
    return this.waitFor(`!!${this.sel(testid)}`, { timeout, message: `[data-testid=${testid}]` });
  }
  async click(testid) {
    const ok = await this.eval(`(() => { const el = ${this.sel(testid)}; if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`click: [data-testid=${testid}] not found`);
  }
  async clickSelector(selector) {
    const ok = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!ok) throw new Error(`click: ${selector} not found`);
  }
  isDisabled(testid) {
    return this.eval(`(() => { const el = ${this.sel(testid)}; return !el || el.disabled === true; })()`);
  }
  bodyText() {
    return this.eval("document.body.innerText");
  }
  activeTestId() {
    return this.eval("document.activeElement ? document.activeElement.getAttribute('data-testid') : null");
  }
  async press(name, { shift = false } = {}) {
    const k = KEYS[name];
    const modifiers = shift ? 8 : 0;
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", modifiers, ...k });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k, text: undefined });
    await sleep(30);
  }
  async setInputFiles(selector, files) {
    const { root } = await this.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`setInputFiles: ${selector} not found`);
    await this.send("DOM.setFileInputFiles", { files, nodeId });
  }
  async setFilesForChooser(event, files) {
    await this.send("DOM.setFileInputFiles", { files, backendNodeId: event.backendNodeId });
  }
  async close() {
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      /* ignore */
    }
  }
}

export { sleep };
