import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildConfirmationCardBundle } from "@/client/phrases";
import { StaffResponseRecords } from "@/components/StaffResponseRecords";
import {
  createStaffResponseContext, STAFF_RESPONSE_STORAGE_KEY, deleteStaffResponses, hashStaffResponseContext,
  restoreStaffResponses, saveStaffResponses,
} from "@/client/staffResponseStorage";
import type { StorageLike } from "@/client/settingsStorage";

const _notice = "SYNTHETIC TEST DATA";
const ids = ["Q_ALLERGEN_EGG", "Q_CROSS_CONTACT"];
const hash = "a".repeat(64);
function memoryStorage() {
  const values = new Map<string, string>();
  const target: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { target, values };
}
function validValue() {
  return { version: 2, epoch: "00000000-0000-4000-8000-000000000000", source: "user_recorded_staff_response", contextHash: hash,
    answers: [{ questionId: ids[0], answer: "no" }] };
}

describe("質問別の店員回答の端末内記録", () => {
  it("明示的同意がない保存は既存値にも触れない", () => {
    const { target, values } = memoryStorage();
    values.set(STAFF_RESPONSE_STORAGE_KEY, _notice);
    expect(saveStaffResponses(hash, { [ids[0]!]: "yes" }, ids, false, target)).toBe(false);
    expect(values.get(STAFF_RESPONSE_STORAGE_KEY)).toBe(_notice);
  });

  it("3種類の回答を保存・復元し、未記録の質問を補完しない", () => {
    const { target, values } = memoryStorage();
    const questionIds = [...ids, "Q_OIL", "Q_BROTH"];
    const answers = { Q_ALLERGEN_EGG: "yes", Q_CROSS_CONTACT: "no", Q_OIL: "unknown" } as const;
    expect(saveStaffResponses(hash, answers, questionIds, true, target)).toBe(true);
    expect(restoreStaffResponses(hash, questionIds, target)).toEqual({ status: "restored", answers });
    const stored = JSON.parse(values.get(STAFF_RESPONSE_STORAGE_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(["answers", "contextHash", "epoch", "source", "version"]);
    expect(stored.answers).toHaveLength(3);
    expect(deleteStaffResponses(target)).toBe(true);
    expect(restoreStaffResponses(hash, questionIds, target)).toEqual({ status: "missing" });
  });

  it.each([
    ["破損JSON", "{"], ["null", "null"], ["旧スキーマ", JSON.stringify({ ...validValue(), version: 0 })],
    ["AI由来", JSON.stringify({ ...validValue(), source: "ai" })],
    ["不明なフィールド", JSON.stringify({ ...validValue(), aiText: _notice })],
    ["不正回答", JSON.stringify({ ...validValue(), answers: [{ questionId: ids[0], answer: "approved" }] })],
    ["重複質問", JSON.stringify({ ...validValue(), answers: [validValue().answers[0], validValue().answers[0]] })],
    ["未知の質問", JSON.stringify({ ...validValue(), answers: [{ questionId: "Q_OTHER", answer: "yes" }] })],
    ["過大データ", " ".repeat(8193)],
  ])("%sを復元せず破棄する", (_label, value) => {
    const { target, values } = memoryStorage();
    values.set(STAFF_RESPONSE_STORAGE_KEY, value);
    expect(restoreStaffResponses(hash, ids, target)).toEqual({ status: "rejected" });
    expect(values.has(STAFF_RESPONSE_STORAGE_KEY)).toBe(false);
  });

  it("文脈の不一致は回答を適用せず破棄する", () => {
    const { target, values } = memoryStorage();
    saveStaffResponses(hash, { Q_ALLERGEN_EGG: "yes" }, ids, true, target);
    expect(restoreStaffResponses("b".repeat(64), ids, target).status).toBe("rejected");
    expect(values.size).toBe(0);
  });

  it("質問・アレルゲン・同一IDの料理本文・言語・メモの違いが復元を拒否する", async () => {
    const bundle = buildConfirmationCardBundle({ userLang: "ja", storeLang: "en", selectedAllergens: ["egg"] });
    const input: Parameters<typeof createStaffResponseContext>[0] = {
      userLang: "ja", storeLang: "en", selectedAllergens: ["egg"],
      targetItems: [{ id: "item-1", readText: { text: _notice, lang: "en", readBy: "ai" },
        aiTranslation: null, readability: "clear", allergens: [] }],
      hasAnalysisResult: true, dataOrigin: "mock_fixture", edits: {}, questions: bundle.allergenQuestions,
    };
    const original = await hashStaffResponseContext(createStaffResponseContext(input));
    const variants = [
      { ...input, userLang: "en", storeLang: "ja" },
      { ...input, selectedAllergens: ["milk"] as const },
      { ...input, targetItems: [{ ...input.targetItems[0]!, readText: { ...input.targetItems[0]!.readText, text: "SYNTHETIC different dish" } }] },
      { ...input, questions: input.questions.map((q) => ({ ...q, storeText: "SYNTHETIC changed question" })) },
      { ...input, edits: { Q_ALLERGEN_EGG: { storeText: "SYNTHETIC memo", userText: "SYNTHETIC memo" } } },
    ];
    for (const variant of variants) {
      const { target } = memoryStorage();
      expect(saveStaffResponses(original, { Q_ALLERGEN_EGG: "yes" }, ids, true, target)).toBe(true);
      const changed = await hashStaffResponseContext(createStaffResponseContext(variant));
      expect(restoreStaffResponses(changed, ids, target).status).toBe("rejected");
    }
  });

  it("保存領域の取得・書込・削除の失敗を呼出元に伝え、例外を漏らさない", () => {
    const target: StorageLike = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(saveStaffResponses(hash, { Q_ALLERGEN_EGG: "yes" }, ids, true, target)).toBe(false);
    expect(restoreStaffResponses(hash, ids, target).status).toBe("unavailable");
    expect(deleteStaffResponses(target)).toBe(false);
    expect(restoreStaffResponses(hash, ids, null).status).toBe("unavailable");
  });


  it("不正データの削除に失敗しても復元せず、削除成功を返さない", () => {
    const target: StorageLike = { getItem: () => "{", setItem: () => {},
      removeItem: () => { throw new Error("blocked"); } };
    expect(restoreStaffResponses(hash, ids, target).status).toBe("unavailable");
  });

  it("保存時も不正な質問・回答・空データを拒否する", () => {
    const { target, values } = memoryStorage();
    expect(saveStaffResponses(hash, {}, ids, true, target)).toBe(false);
    expect(saveStaffResponses(hash, { OTHER: "yes" }, ids, true, target)).toBe(false);
    expect(values.size).toBe(0);
  });

  it.each(["ja", "en"])("%sの初期HTMLはブラウザーの保存値を参照せず未記録で一致する", (userLang) => {
    const bundle = buildConfirmationCardBundle({ userLang, storeLang: userLang === "ja" ? "en" : "ja", selectedAllergens: ["egg"] });
    const render = () => renderToStaticMarkup(React.createElement(StaffResponseRecords, {
      context: _notice, questions: bundle.allergenQuestions, userLang,
      storeLang: userLang === "ja" ? "en" : "ja", enabled: true,
    }));
    const serverHtml = render();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, get() { throw new Error("render must not access window"); } });
    try { expect(render()).toBe(serverHtml); }
    finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
    expect(serverHtml).toContain('type="radio"');
    expect(serverHtml).toContain('aria-live="polite"');
    expect(serverHtml).not.toContain('checked=""');
    expect(serverHtml).toContain(userLang === "ja" ? "未記録" : "Not recorded");
  });
});
