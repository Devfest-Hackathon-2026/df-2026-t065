/* SYNTHETIC TEST DATA. Manual mutation check; restores the exact original source in finally.
 * node tests/e2e/staffResponseMutation.mjs
 * Run without another verification or browser test using these files.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const coordinator = "src/client/staffResponseCoordinator.ts";
const storage = "src/client/staffResponseStorage.ts";
const originals = new Map([coordinator, storage].map(path => [path, readFileSync(path, "utf8")]));
const mutations = [
  ["M5 描画世代と内部同意の検証を除去", coordinator, "if (permissions[action] !== revision || renderedRevision !== revision) return;", "// mutation: stale consent accepted"],
  ["M6 古い描画世代からの再同意を許可", coordinator, "renderedRevision !== revision || ", ""],
  ["M1 世代比較を除去", coordinator, "if (readEpoch(target) !== startedEpoch)", "if (false)"],
  ["M2 削除時の永続世代更新を除去", coordinator, "target.setItem(STAFF_RESPONSE_EPOCH_KEY, next);", "// mutation: no tombstone"],
  ["M3 ローカル失効とアンマウントの検査を除去", coordinator, "if (closed || ticket !== revision) return;", "// mutation: no local cancellation"],
  ["M4 保存スナップショットの世代検証を除去", storage, "snapshot.epoch !== epoch || ", ""],
];
const restore = () => { for (const [path, body] of originals) writeFileSync(path, body); };
const run = () => spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/e2e/staffResponseConcurrency.test.ts", "tests/e2e/staffResponseRecords.test.ts", "--maxWorkers=1"], { encoding: "utf8", timeout: 30_000 });
try {
  assert.equal(run().status, 0, "baseline must pass before mutation testing");
  for (const [name, path, before, after] of mutations) {
    restore();
    const body = originals.get(path);
    assert(body.includes(before), `mutation target missing: ${name}`);
    writeFileSync(path, body.replace(before, after));
    const result = run();
    assert.equal(result.status, 1, `mutation survived or infrastructure failure: ${name}`);
    assert(/Tests\s+\d+ failed/.test(result.stdout), `expected assertion failures: ${name}`);
    console.log(`DETECTED ${name}`);
  }
} finally { restore(); }
assert.equal(run().status, 0, "restored source must pass");
console.log(`PASS ${mutations.length}/${mutations.length} mutations detected; source restored`);
