import { afterEach, expect, it, vi } from "vitest";
import { DIETARY_CONDITION_CODES } from "@/contracts/dietary";
import { DietarySettingsSection } from "@/components/DietarySettingsSection";
import type { DietaryRecord } from "@/client/dietarySettingsDatabase";
import type { DietarySettings } from "@/client/dietarySettingsStorage";
const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/client/dietarySettingsDatabase", () => ({ dietaryTransaction: database.transaction }));
// Inspect the real event handler without a DOM; the browser regression covers React rendering.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useState: (value: unknown) => [value, () => {}],
    useEffect: () => {}, useRef: (value: unknown) => ({ current: value }) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function findInput(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) { const found = findInput(child); if (found) return found; }
  } else if (node && typeof node === "object" && "props" in node) {
    const props = node.props as Record<string, unknown>;
    if (props["data-testid"] === "dietary-cond-honey") return props;
    return findInput(props.children);
  }
  return null;
}
it("SYNTHETIC TEST DATA: a stale 20-condition UI cannot erase a canonical 21-condition profile", async () => {
  let canonical: DietaryRecord = { revision: 2, settings: { activePresets: [], selectedConditions: [...DIETARY_CONDITION_CODES] } };
  database.transaction.mockImplementation((_seed: () => DietarySettings,
    operation: (current: DietaryRecord) => { next?: DietaryRecord; result: unknown }) => {
    const outcome = operation(canonical); if (outcome.next) canonical = outcome.next;
    return Promise.resolve(outcome.result);
  });
  const values = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  vi.stubGlobal("navigator", { locks: { request: (...args: unknown[]) => Promise.resolve((args.at(-1) as () => unknown)()) } });
  const parent = vi.fn();
  const tree = DietarySettingsSection({ userLang: "ja", storeLang: "en",
    settings: { activePresets: [], selectedConditions: DIETARY_CONDITION_CODES.filter(code => code !== "honey") },
    onUpdateSettings: parent, onProceedToDietaryCard: () => {} });
  const change = findInput(tree)?.onChange;
  expect(typeof change).toBe("function");
  (change as (event: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked: true } });
  await vi.waitFor(() => expect(parent).toHaveBeenCalledOnce());
  expect(canonical.settings.selectedConditions).toEqual([...DIETARY_CONDITION_CODES]);
  expect(canonical.settings.selectedConditions).toHaveLength(21);
});
