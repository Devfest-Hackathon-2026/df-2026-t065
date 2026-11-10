// _notice: SYNTHETIC TEST DATA. Executes the actual worker, not a duplicate policy.
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOfflineReady } from "@/client/serviceWorkerRegistration";

const source = readFileSync("public/sw.js", "utf8");
const origin = "https://example.test";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bodies: Record<string, string> = {
  "/": '<script src="/_next/static/a.js"></script><link rel="stylesheet" href="/_next/static/b.css">',
  "/_next/static/a.js": "/* SYNTHETIC JS */",
  "/_next/static/b.css": "/* SYNTHETIC CSS */",
};
const manifest = { buildId: "build-A", rootHash: hash(bodies["/"]!), assets: Object.fromEntries(
  Object.entries(bodies).filter(([path]) => path !== "/").map(([path, body]) => [path, hash(body)]),
) };

function runtime(options: { badHeader?: string; wrongBody?: boolean; failure?: "read" | "write" | "keys"; windows?: number } = {}) {
  const stores = new Map<string, Map<string, Response>>();
  const key = (request: string | Request) => new URL(typeof request === "string" ? request : request.url, origin).pathname;
  const caches = {
    has: async (name: string) => stores.has(name),
    keys: async () => { if (options.failure === "keys") throw Error("SYNTHETIC denied"); return [...stores.keys()]; },
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (request: string | Request) => {
          if (options.failure === "read") throw Error("SYNTHETIC denied");
          return store.get(key(request))?.clone();
        },
        put: async (request: string | Request, response: Response) => {
          if (options.failure === "write") throw Error("SYNTHETIC quota");
          store.set(key(request), response.clone());
        },
      };
    },
  };
  const handlers: Record<string, (event: unknown) => void> = {};
  const fetch = vi.fn(async (request: Request) => {
    const path = key(request);
    const response = new Response(options.wrongBody ? "OTHER BUILD" : bodies[path] || "SYNTHETIC PRIVATE", {
      headers: { "Content-Type": path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "Cache-Control": options.badHeader || "public" },
    });
    Object.defineProperties(response, { type: { value: "basic" }, url: { value: new URL(path, origin).href } });
    return response;
  });
  const claim = vi.fn();
  const worker = runInNewContext(`${source}\n({safePrecacheAll, completeBuildCached, safeCacheMatch, isResponseCacheable, STATIC_CACHE_NAME})`, {
    BUILD_MANIFEST: manifest, crypto: webcrypto, caches, fetch, Request, Response, URL,
    self: { location: { origin }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; },
      clients: { claim, matchAll: async () => Array.from({ length: options.windows || 0 }, () => ({})) } },
  });
  const install = () => new Promise<void>((resolve, reject) => handlers.install!({ waitUntil: (p: Promise<void>) => p.then(resolve, reject) }));
  const activate = () => new Promise<void>((resolve, reject) => handlers.activate!({ waitUntil: (p: Promise<void>) => p.then(resolve, reject) }));
  async function request(path: string, method = "GET") {
    let response: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.fetch!({ request: new Request(new URL(path, origin), { method }), respondWith: (p: Promise<Response>) => { response = p; }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    const result = response ? await response : undefined;
    await Promise.all(pending);
    return result;
  }
  return { stores, worker, install, activate, request, fetch, claim };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Worker dynamic integrity and fault injection", () => {
  it.each([
    { redirected: true }, { type: "cors" }, { type: "opaque" }, { status: 404 }, { status: 500 },
    { url: `${origin}/api/private` }, { url: "https://foreign.test/_next/static/a.js" },
    { url: `${origin}/_next/static/a.js?synthetic=1` },
  ])("rejects unsafe network response %j", (override) => {
    const r = runtime();
    const response = { status: 200, type: "basic", redirected: false, url: `${origin}/_next/static/a.js`,
      headers: new Headers({ "Content-Type": "application/javascript" }), ...override };
    expect(r.worker.isResponseCacheable(new Request(`${origin}/_next/static/a.js`), response)).toBe(false);
  });
  it("requires every referenced asset, rejects one chunk, eviction and wrong-build bytes", async () => {
    const r = runtime();
    await r.install();
    expect(await r.worker.completeBuildCached()).toBe(true);
    const cache = r.stores.get(r.worker.STATIC_CACHE_NAME)!;
    cache.delete("/_next/static/b.css");
    expect(await r.worker.completeBuildCached()).toBe(false);
    cache.set("/_next/static/b.css", new Response("OTHER BUILD CSS"));
    expect(await r.worker.completeBuildCached()).toBe(false);
  });
  it.each(["private", "no-store", "no-cache"])("rejects %s during install and retains the old generation", async (badHeader) => {
    const r = runtime({ badHeader });
    r.stores.set("allergy-bridge-build-old", new Map([["/", new Response("OLD")]]));
    await expect(r.install()).rejects.toThrow();
    expect(r.stores.get("allergy-bridge-build-old")!.has("/")).toBe(true);
    expect(await r.worker.completeBuildCached()).toBe(false);
  });
  it("rejects a different deployment's HTML during install", async () => {
    const r = runtime({ wrongBody: true });
    await expect(r.install()).rejects.toThrow();
  });
  it.each(["read", "write", "keys"] as const)("%s failure does not break online network responses", async (failure) => {
    const r = runtime({ failure });
    const response = await r.request("/_next/static/a.js");
    expect(await response!.text()).toBe(bodies["/_next/static/a.js"]);
    if (failure !== "keys") expect(await r.worker.completeBuildCached()).toBe(false);
    await r.activate();
    expect(r.claim).toHaveBeenCalled();
  });
  it("retains old assets while any tab may use them, and preserves unrelated caches", async () => {
    const r = runtime({ windows: 2 });
    r.stores.set("allergy-bridge-build-old", new Map());
    r.stores.set("unrelated", new Map());
    await r.activate();
    expect(r.stores.has("allergy-bridge-build-old")).toBe(true);
    expect(r.stores.has("unrelated")).toBe(true);
  });
  it("cleans only its namespace when no old windows exist", async () => {
    const r = runtime();
    r.stores.set("allergy-bridge-build-old", new Map());
    r.stores.set("unrelated", new Map());
    await r.activate();
    expect(r.stores.has("allergy-bridge-build-old")).toBe(false);
    expect(r.stores.has("unrelated")).toBe(true);
  });
  it.each(["/api/private", "/api", "/%61pi/private", "/api%2fprivate", "/?secret=synthetic", "/private.json", "/photo.jpg", "/_next/static/unknown.js"])("never intercepts or stores %s", async (path) => {
    const r = runtime();
    expect(await r.request(path)).toBeUndefined();
    expect(r.stores.size).toBe(0);
  });
  it("does not intercept non-GET", async () => {
    expect(await runtime().request("/_next/static/a.js", "POST")).toBeUndefined();
  });
  it("cached bytes have no incidental response or authentication headers", async () => {
    const r = runtime();
    await r.install();
    const stored = r.stores.get(r.worker.STATIC_CACHE_NAME)!.get("/")!;
    expect([...stored.headers.keys()]).toEqual(["content-type"]);
    expect(r.fetch.mock.calls.every(([request]) => request.credentials === "omit")).toBe(true);
  });
});

describe("Client readiness requires the controlling worker and the current build", () => {
  it("fails closed if browser access to serviceWorker throws", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", Object.defineProperty({}, "serviceWorker", { get: () => { throw new Error("SYNTHETIC denied"); } }));
    expect(await isOfflineReady()).toBe(false);
  });
  it("fails closed if MessageChannel construction is denied", async () => {
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_BUILD_ID", "build-A");
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
    vi.stubGlobal("MessageChannel", class { constructor() { throw new Error("SYNTHETIC denied"); } });
    expect(await isOfflineReady()).toBe(false);
  });
  it.each([true, false])("checks complete=%s against the build identity", async (complete) => {
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_BUILD_ID", "build-A");
    const controller = { postMessage: (_message: unknown, ports: MessagePort[]) => ports[0]!.postMessage({ type: "PRECACHE_STATUS", complete, version: "build-A" }) };
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { serviceWorker: { controller } });
    expect(await isOfflineReady()).toBe(complete);
  });
  it("rejects another generation even if it is complete", async () => {
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_BUILD_ID", "build-B");
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage: (_: unknown, ports: MessagePort[]) => ports[0]!.postMessage({ type: "PRECACHE_STATUS", complete: true, version: "build-A" }) } } });
    expect(await isOfflineReady()).toBe(false);
  });
});
