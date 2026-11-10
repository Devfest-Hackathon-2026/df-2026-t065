import { describe, expect, it } from "vitest";
import { createStaffResponseSession, STAFF_RESPONSE_EPOCH_KEY, type ResponsePersistenceRuntime } from "@/client/staffResponseCoordinator";
import { STAFF_RESPONSE_STORAGE_KEY, type StaffAnswers } from "@/client/staffResponseStorage";

const _notice = "SYNTHETIC TEST DATA";
const ids = ["Q_ALLERGEN_EGG"];
const answers: StaffAnswers = { Q_ALLERGEN_EGG: "yes" };
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
// Unit model of the atomic record; native IndexedDB is exercised by browser tests.
function harness() {
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  let sequence = 0;
  let tail = Promise.resolve();
  const lock: NonNullable<ResponsePersistenceRuntime["lock"]> = (task) => {
    const result = tail.then(task);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const runtime: ResponsePersistenceRuntime = {
    lock,
    transaction: async (task, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      const draft = { epoch: values.get(STAFF_RESPONSE_EPOCH_KEY) ?? null, snapshot: values.get(STAFF_RESPONSE_STORAGE_KEY) ?? null };
      const result = task(draft);
      if (signal?.aborted) throw new Error("aborted");
      if (draft.epoch === null) values.delete(STAFF_RESPONSE_EPOCH_KEY); else values.set(STAFF_RESPONSE_EPOCH_KEY, draft.epoch);
      if (draft.snapshot === null) values.delete(STAFF_RESPONSE_STORAGE_KEY); else values.set(STAFF_RESPONSE_STORAGE_KEY, draft.snapshot);
      return result;
    },
    cleanupLegacy: () => {}, notify: () => {},
    newEpoch: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    hash: async (context) => (context === _notice ? "a" : "b").repeat(64),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  function tab(overrides: Partial<ResponsePersistenceRuntime> = {}) {
    const state = { revision: null as number | null, ready: false, consent: false, restoreConsent: false, resets: 0, status: "", answers: {} as StaffAnswers };
    const session = createStaffResponseSession({ ...runtime, ...overrides }, {
      reset: () => { state.ready = false; state.revision = null; state.consent = false; state.restoreConsent = false; state.resets++; state.answers = {}; state.status = "invalidated"; },
      ready: (revision) => { state.ready = true; state.revision = revision; },
      result: (result) => { state.status = result.status; if (result.answers) state.answers = result.answers; },
    });
    return { state, session,
      agree() {
        state.consent = session.authorize("save", true, state.revision);
        state.restoreConsent = session.authorize("restore", true, state.revision);
      },
      save(context = _notice) { return session.persist("save", context, answers, ids, state.consent, state.revision); },
      restore(context = _notice) { return session.persist("restore", context, {}, ids, state.restoreConsent, state.revision); },
    };
  }
  return { values, runtime, tab, notify: () => listeners.forEach((listener) => listener()),
    hold: () => { const gate = deferred(); const held = lock(() => gate.promise); return { ...gate, held }; } };
}

describe("MAJOR-1: 削除の優先とタブ間の競合", () => {
  it.each(["save", "restore"] as const)("%s待機→別タブ全削除→通知前に再開しても適用しない", async (action) => {
    const h = harness();
    const b = h.tab(); await b.session.initialize(); b.agree(); await b.save();
    const gate = deferred();
    const a = h.tab({ hash: async () => { await gate.promise; return "a".repeat(64); } });
    await a.session.initialize(); a.agree();
    const pending = action === "save" ? a.save() : a.restore();
    await b.session.deleteAll(); // No storage event delivered to A.
    expect(b.state.status).toBe("deleted");
    gate.release(); await pending;
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    expect(a.state.status).toBe("invalidated");
    expect(a.state.answers).toEqual({});
    expect(a.state.consent).toBe(false);
    expect(a.state.restoreConsent).toBe(false);
  });

  it("削除がロック待機中に始まった別タブ保存も、削除後には書き込めない", async () => {
    const h = harness(); const a = h.tab(); const b = h.tab();
    await a.session.initialize(); await b.session.initialize(); b.agree();
    const held = h.hold();
    const deletion = a.session.deleteAll();
    const save = b.save();
    await Promise.resolve();
    held.release(); await held.held; await deletion; await save;
    expect(a.state.status).toBe("deleted");
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    expect(b.state.consent).toBe(false);
  });

  it("同一タブの保留保存・連続保存削除・削除後の新しい同意", async () => {
    const h = harness(); const gate = deferred(); let pause = false;
    const a = h.tab({ hash: async () => { if (pause) await gate.promise; return "a".repeat(64); } });
    await a.session.initialize(); a.agree(); await a.save();
    pause = true; const pending = a.save(); await a.session.deleteAll();
    gate.release(); await pending;
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    await a.save(); // Old consent was cleared, so this is a no-op.
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    for (let i = 0; i < 4; i++) {
      a.agree(); await a.save(); expect(a.state.status).toBe("saved");
      await a.session.deleteAll(); expect(a.state.status).toBe("deleted");
    }
    a.agree(); await a.save();
    expect(a.state.status).toBe("saved");
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(true);
  });

  it("複数タブ同時保存を直列化し、削除との同時実行後に回答が残らない", async () => {
    const h = harness(); const tabs = [h.tab(), h.tab(), h.tab()];
    await Promise.all(tabs.map((t) => t.session.initialize()));
    tabs.forEach((t) => t.agree());
    await Promise.all(tabs.map((t) => t.save()));
    expect(tabs.every((t) => t.state.status === "saved")).toBe(true);
    const held = h.hold();
    const pending = tabs.map((t) => t.save());
    const deleted = tabs[0]!.session.deleteAll();
    held.release(); await held.held; await Promise.all([...pending, deleted]);
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

  it("遅延したstorage通知で保存済み表示・回答・両同意を失効させる", async () => {
    const h = harness(); const a = h.tab(); const b = h.tab();
    await a.session.initialize(); await b.session.initialize(); a.agree(); await a.save();
    await b.session.deleteAll();
    h.notify();
    expect(a.state.status).toBe("invalidated");
    expect(a.state.consent || a.state.restoreConsent).toBe(false);
    expect(a.state.answers).toEqual({});
  });

  it("再読み込みした新規セッションでも削除済み回答を復元しない", async () => {
    const h = harness(); const a = h.tab(); await a.session.initialize(); a.agree(); await a.save();
    await a.session.deleteAll(); a.session.close();
    expect(h.values.size).toBe(1); // Only the non-sensitive epoch tombstone remains.
    const reloaded = h.tab(); await reloaded.session.initialize(); reloaded.agree(); await reloaded.restore();
    expect(reloaded.state.status).toBe("missing");
    expect(reloaded.state.answers).toEqual({});
  });

  it("保存・復元の文脈が違えば回答を適用しない", async () => {
    const h = harness(); const a = h.tab(); await a.session.initialize(); a.agree(); await a.save();
    const b = h.tab(); await b.session.initialize(); b.agree(); await b.restore("other synthetic context");
    expect(b.state.status).toBe("rejected");
    expect(b.state.answers).toEqual({});
  });

  it("削除後に古いReactハンドラーの同意trueや古い描画世代を再利用できない", async () => {
    const h = harness(); const a = h.tab(); await a.session.initialize(); a.agree();
    const oldRenderedRevision = a.state.revision;
    await a.save(); await a.session.deleteAll();
    // Simulate callbacks retained from a render before the reset reached the DOM.
    await a.session.persist("save", _notice, answers, ids, true, oldRenderedRevision);
    await a.session.persist("restore", _notice, {}, ids, true, oldRenderedRevision);
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    expect(a.session.authorize("save", true, oldRenderedRevision)).toBe(false);
    expect(a.session.authorize("restore", true, oldRenderedRevision)).toBe(false);
    await a.session.persist("save", _notice, answers, ids, true, oldRenderedRevision);
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    a.agree(); await a.save(); expect(a.state.status).toBe("saved");
    const fresh = h.values.get(STAFF_RESPONSE_STORAGE_KEY);
    await a.session.persist("save", _notice, { Q_ALLERGEN_EGG: "no" }, ids, true, oldRenderedRevision);
    expect(h.values.get(STAFF_RESPONSE_STORAGE_KEY)).toBe(fresh);
  });

  it("Web Locksなしでは保存・復元を実行せず、全削除も保証成功と表示しない", async () => {
    const h = harness(); const a = h.tab({ lock: undefined });
    await a.session.initialize(); a.agree(); await a.save(); await a.restore();
    expect(a.state.status).toBe("noLock");
    expect(h.values.size).toBe(0);
    await a.session.deleteAll(); expect(a.state.status).toBe("noLockDelete");
  });

  it("ロック取得失敗とtransaction例外を漏らさず削除成功を返さない", async () => {
    for (const overrides of [
      { lock: async () => { throw new Error("blocked"); } },
      { transaction: async () => { throw new Error("blocked"); } },
    ]) {
      const h = harness(); const a = h.tab(overrides);
      await a.session.initialize(); expect(a.state.status).toBe("unavailable");
      await a.session.deleteAll(); expect(a.state.status).toBe("deleteFailed");
    }
  });

  it("原子的削除のcommit失敗は成功と表示せず、半端な世代更新を残さない", async () => {
    const h = harness(); const a = h.tab(); await a.session.initialize(); a.agree(); await a.save();
    const before = new Map(h.values);
    const b = h.tab({ transaction: async () => { throw new Error("commit aborted"); } });
    await b.session.deleteAll();
    expect(b.state.status).toBe("deleteFailed");
    expect(b.state.consent || b.state.restoreConsent).toBe(false);
    expect(h.values).toEqual(before); // Atomic abort: no partial tombstone or false deletion success.
    await a.session.deleteAll();
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

  it("原子的ストアの世代が失われても古い待機保存を拒否する", async () => {
    const h = harness(); const gate = deferred();
    const a = h.tab({ hash: async () => { await gate.promise; return "a".repeat(64); } });
    await a.session.initialize(); a.agree(); const oldEpoch = h.values.get(STAFF_RESPONSE_EPOCH_KEY);
    const save = a.save(); h.values.clear(); gate.release(); await save;
    expect(h.values.get(STAFF_RESPONSE_EPOCH_KEY)).not.toBe(oldEpoch);
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

  it("旧v1スナップショットと不正な世代値は安全側に拒否する", async () => {
    const h = harness(); h.values.set(STAFF_RESPONSE_EPOCH_KEY, "broken");
    const a = h.tab(); await a.session.initialize();
    expect(a.state.status).toBe("unavailable");
    await a.session.deleteAll(); expect(a.state.status).toBe("deleted");
    h.values.set(STAFF_RESPONSE_STORAGE_KEY, JSON.stringify({ version: 1, source: "user_recorded_staff_response", contextHash: "a".repeat(64), answers: [{ questionId: ids[0], answer: "yes" }] }));
    a.agree(); await a.restore(); expect(a.state.status).toBe("rejected");
  });

  it("アンマウント後にハッシュが完了しても保存しない", async () => {
    const h = harness(); const gate = deferred();
    const a = h.tab({ hash: async () => { await gate.promise; return "a".repeat(64); } });
    await a.session.initialize(); a.agree(); const pending = a.save();
    a.session.close(); gate.release(); await pending;
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });
  it("保存transactionの開始前にタブを閉じるとcommitせず、通知もしない", async () => {
    const h = harness(); const gate = deferred(); let pause = false;
    const a = h.tab({ transaction: async (task, signal) => { if (pause) await gate.promise; return h.runtime.transaction(task, signal); } });
    await a.session.initialize(); a.agree(); pause = true;
    const pending = a.save(); await Promise.resolve(); a.session.close(); gate.release(); await pending;
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
    expect(a.state.status).not.toBe("saved");
  });

  it("旧回答の削除失敗では保存を有効にせず、IDBの回答削除を試みても削除成功としない", async () => {
    const h = harness(); const a = h.tab(); await a.session.initialize(); a.agree(); await a.save();
    const b = h.tab({ cleanupLegacy: () => { throw new Error("legacy removal blocked"); } });
    await b.session.initialize(); expect(b.state.status).toBe("unavailable");
    b.agree(); expect(b.state.consent || b.state.restoreConsent).toBe(false);
    await b.session.deleteAll(); expect(b.state.status).toBe("deleteFailed");
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

  it("保存commit失敗では成功通知を出さず、既存snapshotを変更しない", async () => {
    const h = harness(); const a = h.tab(); await a.session.initialize(); a.agree(); await a.save();
    const before = new Map(h.values); let fail = false;
    const b = h.tab({ transaction: async (task, signal) => { if (fail) throw new Error("abort"); return h.runtime.transaction(task, signal); } });
    await b.session.initialize(); b.agree(); fail = true; await b.save();
    expect(b.state.status).toBe("unavailable"); expect(h.values).toEqual(before);
  });

  it("通知の欠落・失敗でも原子的な世代照合で旧同意を失効させる", async () => {
    const h = harness(); const a = h.tab({ notify: () => { throw new Error("notification blocked"); } });
    const b = h.tab(); await a.session.initialize(); await b.session.initialize(); a.agree(); await a.save();
    await b.session.deleteAll(); await a.save();
    expect(a.state.status).toBe("invalidated"); expect(a.state.answers).toEqual({});
    expect(a.state.consent || a.state.restoreConsent).toBe(false);
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

  it("遅延通知は同意を失効させるが、明示的な削除transactionを中止しない", async () => {
    const h = harness(); const gate = deferred(); const started = deferred(); let pause = false;
    const a = h.tab({ transaction: async (task, signal) => { if (pause) { started.release(); await gate.promise; } return h.runtime.transaction(task, signal); } });
    await a.session.initialize(); a.agree(); await a.save(); pause = true;
    const deletion = a.session.deleteAll(); await started.promise;
    h.notify(); gate.release(); await deletion;
    expect(a.state.status).toBe("deleted");
    expect(a.state.consent || a.state.restoreConsent).toBe(false);
    expect(h.values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

});
