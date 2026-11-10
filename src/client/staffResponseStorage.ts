import { z } from "zod";
import type { AllergenCode } from "@/contracts/allergens";
import type { AnalyzeMenuResponse, MenuItem } from "@/contracts/analyze";
import type { PhraseEditsMap } from "./cardEditor";
import type { BilingualDisplayPhrase } from "./phrases";
import type { StorageLike } from "./settingsStorage";

export const STAFF_RESPONSE_STORAGE_KEY = "allergy_bridge_staff_responses";
export const ANSWER_VALUES = ["yes", "no", "unknown"] as const;
export type StaffAnswer = (typeof ANSWER_VALUES)[number];
export type StaffAnswers = Record<string, StaffAnswer>;

const SnapshotSchema = z.object({
  version: z.literal(2),
  epoch: z.string().uuid(),
  source: z.literal("user_recorded_staff_response"),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  answers: z.array(z.object({
    questionId: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    answer: z.enum(ANSWER_VALUES),
  }).strict()).min(1).max(32),
}).strict();

/** Full context stays in memory. Dish content prevents reuse when an analysis reuses IDs. */
export function createStaffResponseContext(input: {
  userLang: string;
  storeLang: string;
  selectedAllergens: readonly AllergenCode[];
  targetItems: readonly MenuItem[];
  hasAnalysisResult: boolean;
  dataOrigin: AnalyzeMenuResponse["dataOrigin"] | null;
  edits: PhraseEditsMap;
  questions: readonly BilingualDisplayPhrase[];
}): string {
  return JSON.stringify({
    userLang: input.userLang, storeLang: input.storeLang,
    allergens: [...input.selectedAllergens].sort(), targetItems: input.targetItems,
    hasAnalysisResult: input.hasAnalysisResult, dataOrigin: input.dataOrigin, edits: input.edits,
    questions: input.questions.map(({ id, storeText, userText }) => ({ id, storeText, userText })),
  });
}

/** Only the digest is persisted: never question text, AI output, dish IDs or memos. */
export async function hashStaffResponseContext(context: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(context));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function deleteStaffResponses(target: StorageLike | null): boolean {
  try {
    if (!target) return false;
    target.removeItem(STAFF_RESPONSE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous codec primitive. The application supplies an IN-MEMORY adapter
 * inside its IndexedDB transaction, never browser localStorage. */
export function saveStaffResponses(
  contextHash: string,
  answers: StaffAnswers,
  questionIds: readonly string[],
  consent: boolean,
  target: StorageLike | null,
  epoch = "00000000-0000-4000-8000-000000000000",
): boolean {
  if (!consent || !target) return false;
  const parsed = SnapshotSchema.safeParse({
    version: 2,
    epoch,
    source: "user_recorded_staff_response",
    contextHash,
    answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })),
  });
  if (!parsed.success || parsed.data.answers.some((entry) => !questionIds.includes(entry.questionId))) return false;
  try {
    target.setItem(STAFF_RESPONSE_STORAGE_KEY, JSON.stringify(parsed.data));
    return true;
  } catch {
    return false;
  }
}

export type RestoreResult =
  | { status: "restored"; answers: StaffAnswers }
  | { status: "missing" | "rejected" | "unavailable" };

/** Restore is explicit; even matching questions cannot identify a restaurant or conversation. */
export function restoreStaffResponses(
  contextHash: string,
  questionIds: readonly string[],
  target: StorageLike | null,
  epoch = "00000000-0000-4000-8000-000000000000",
): RestoreResult {
  if (!target) return { status: "unavailable" };
  try {
    const raw = target.getItem(STAFF_RESPONSE_STORAGE_KEY);
    if (raw === null) return { status: "missing" };
    let value: unknown;
    try { value = raw.length <= 8192 ? JSON.parse(raw) : null; } catch { value = null; }
    const parsed = SnapshotSchema.safeParse(value);
    if (!parsed.success) {
      return { status: deleteStaffResponses(target) ? "rejected" : "unavailable" };
    }
    const snapshot = parsed.data;
    const ids = snapshot.answers.map((entry) => entry.questionId);
    if (snapshot.epoch !== epoch || snapshot.contextHash !== contextHash || new Set(ids).size !== ids.length ||
        ids.some((id) => !questionIds.includes(id))) {
      return { status: deleteStaffResponses(target) ? "rejected" : "unavailable" };
    }
    return { status: "restored", answers: Object.fromEntries(snapshot.answers.map((entry) => [entry.questionId, entry.answer])) };
  } catch {
    return { status: "unavailable" };
  }
}
