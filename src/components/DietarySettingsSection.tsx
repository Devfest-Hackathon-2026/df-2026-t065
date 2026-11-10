"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  DIETARY_CONDITIONS,
  DIETARY_PRESETS,
  DIETARY_CONDITION_CODES,
  type DietaryConditionCategory,
  type DietaryConditionCode,
  type DietaryPresetId,
} from "@/contracts/dietary";
import {
  applyPresetToggle,
  eraseDietarySettingsResult,
  updateDietarySettingsResult,
  type DietarySettings,
  type SaveDietarySettingsResult,
  type ClearDietarySettingsResult,
} from "@/client/dietarySettingsStorage";
import styles from "./DietarySettingsSection.module.css";

export type DietarySettingsSectionProps = {
  userLang: string;
  storeLang: string;
  settings: DietarySettings;
  onBeginOperation?: () => number;
  onPendingChange?: (pending: boolean) => void;
  onInvalidateOperations?: () => void;
  onUpdateSettings: (result: SaveDietarySettingsResult | ClearDietarySettingsResult, generation: number,
    intent: (current: DietarySettings) => DietarySettings) => DietarySettings | null | void | Promise<DietarySettings | null | void>;
  onProceedToDietaryCard: () => void;
};

const CATEGORIES: readonly { id: DietaryConditionCategory; labelJa: string; labelEn: string }[] = [
  { id: "meat_animal_derived", labelJa: "1. 肉類・動物由来原料", labelEn: "1. Meats & Animal Derivatives" },
  { id: "broth_seasoning", labelJa: "2. 出汁・調味料・アルコール", labelEn: "2. Broths, Seasonings & Alcohol" },
  { id: "preparation_equipment", labelJa: "3. 調理工程・器具共用・認証", labelEn: "3. Preparation, Shared Equipment & Certification" },
];

export function DietarySettingsSection({
  userLang,
  settings,
  onUpdateSettings,
  onBeginOperation,
  onPendingChange,
  onInvalidateOperations,
  onProceedToDietaryCard,
}: DietarySettingsSectionProps) {
  const isJa = userLang === "ja";
  const [clearedBanner, setClearedBanner] = useState(false);
  const [storageErrorBanner, setStorageErrorBanner] = useState<string | null>(null);

  const selectedSet = new Set(settings.selectedConditions);
  const activePresetSet = new Set(settings.activePresets);
  const canProceed = settings.selectedConditions.length > 0;

  const memoryRef = useRef(settings);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCountRef = useRef(0);
  const [pending, setPending] = useState(false);
  useEffect(() => { memoryRef.current = settings; }, [settings]);
  const mountedRef = useRef(true);
  const invalidateRef = useRef(onInvalidateOperations);
  useEffect(() => { invalidateRef.current = onInvalidateOperations; }, [onInvalidateOperations]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; invalidateRef.current?.(); };
  }, []);

  const mutate = (update: (current: DietarySettings) => DietarySettings) => {
    setClearedBanner(false);
    pendingCountRef.current += 1;
    setPending(true);
    onPendingChange?.(true);
    queueRef.current = queueRef.current.then(async () => {
      if (!mountedRef.current) return;
      const generation = onBeginOperation?.() ?? 0;
      const result = await updateDietarySettingsResult(update, memoryRef.current);
      // Parent owns canonical reconciliation even if this section was removed.
      const accepted = await onUpdateSettings(result, generation, update);
      if (!mountedRef.current) return;
      if (accepted) memoryRef.current = accepted;
      setStorageErrorBanner(result.ok ? null : isJa
        ? "保存完了を確認できません。この画面では一時利用できますが、一部の保存データが端末に残る可能性があり、再読込後の保持や他タブとの同期は保証できません。保存データは「食事制約設定を消去」で消去してください。"
        : "Saving could not be confirmed. You can use these selections temporarily on this page. Some stored data may remain on this device; retention after reload and synchronization with other tabs are not guaranteed. Use Reset Stored Conditions to erase saved data.");
    }).finally(() => {
      pendingCountRef.current -= 1;
      onPendingChange?.(pendingCountRef.current > 0);
      if (mountedRef.current) setPending(pendingCountRef.current > 0);
    });
  };
  const handleTogglePreset = (id: DietaryPresetId) => {
    const activate = !activePresetSet.has(id);
    mutate(current => current.activePresets.includes(id) === activate
      ? current : applyPresetToggle(current, id));
  };
  const handleSetCondition = (code: DietaryConditionCode, selected: boolean) => mutate(current => ({
    ...current,
    selectedConditions: selected
      ? current.selectedConditions.includes(code) ? current.selectedConditions : [...current.selectedConditions, code]
      : current.selectedConditions.filter(c => c !== code),
  }));
  const handleSelectAll = () => mutate(current => ({ ...current, selectedConditions: [...DIETARY_CONDITION_CODES] }));
  const handleClearAllConditions = () => mutate(() => ({ activePresets: [], selectedConditions: [] }));
  const handleResetStorage = () => {
    pendingCountRef.current += 1;
    setPending(true);
    onPendingChange?.(true);
    queueRef.current = queueRef.current.then(async () => {
      if (!mountedRef.current) return;
      const generation = onBeginOperation?.() ?? 0;
      const result = await eraseDietarySettingsResult();
      const accepted = await onUpdateSettings(result, generation, () => ({ activePresets: [], selectedConditions: [] }));
      if (!mountedRef.current) return;
      if (accepted) memoryRef.current = accepted;
      setClearedBanner(result.ok && accepted !== null);
      setStorageErrorBanner(result.ok ? null : isJa
        ? "端末ストレージからの消去を完了できませんでした。現在の選択と保存データは一致しない可能性があり、保存データの消去や他タブとの同期は保証できません。"
        : "Device erasure could not be completed. Current selections may differ from stored data; stored-data removal and synchronization with other tabs are not guaranteed.");
    }).finally(() => {
      pendingCountRef.current -= 1;
      onPendingChange?.(pendingCountRef.current > 0);
      if (mountedRef.current) setPending(pendingCountRef.current > 0);
    });
  };

  return (
    <section
      className={styles.sectionCard}
      aria-labelledby="dietary-settings-title"
      data-testid="dietary-settings-section"
      aria-busy={pending}
    >
      <div className={styles.sectionHeader}>
        <h3 id="dietary-settings-title" className={styles.sectionTitle}>
          {isJa ? "食事制約・条件の設定（ヴィーガン・宗教的配慮等）" : "Dietary Restrictions & Inquiries (Vegan, Halal, Kosher, etc.)"}
          <span className={styles.badge}>{isJa ? "新機能" : "New"}</span>
        </h3>
      </div>

      <div className={styles.noticeAlert} role="note">
        <strong>
          {isJa
            ? "【重要】適合判定や安全保証は行いません"
            : "[IMPORTANT] We do not certify compliance or food safety"}
        </strong>
        {isJa
          ? "本機能は、利用者が避けたい食材や確認したい調理条件を指定し、店員に確認する質問カードを作成する支援を行います。宗派や地域、個人の実践によって基準が異なります。プリセットを選んだ後、具体的な確認項目をご自身の判断で編集してください。"
          : "This feature helps you prepare specific questions to ask restaurant staff about ingredients and preparation. Standards vary by region, school of thought, and personal practice. Please review and customize the checklist below based on your own needs."}
      </div>

      <div className={styles.subSectionTitle}>
        {isJa ? "プリセット（出発点の例を選択）" : "Presets (Select starting template)"}
      </div>
      <div className={styles.presetGrid}>
        {DIETARY_PRESETS.map((preset) => {
          const isActive = activePresetSet.has(preset.id);
          return (
            <button
              key={preset.id}
              type="button"
              className={`${styles.presetCard} ${isActive ? styles.presetCardActive : ""}`}
              onClick={() => handleTogglePreset(preset.id)}
              aria-pressed={isActive}
              data-testid={`dietary-preset-${preset.id}`}
            >
              <div>
                <div className={styles.presetName}>
                  {isActive ? "✓ " : ""}
                  {isJa ? preset.labelJa : preset.labelEn}
                </div>
                <div className={styles.presetDesc}>
                  {isJa ? preset.rationaleJa : preset.rationaleEn}
                </div>
              </div>
              <div className={styles.presetMeta}>
                {isJa ? "出典・根拠: " : "Source: "}
                {preset.sourceReference}
                {isJa ? "（原資料の参照箇所は未確認）" : " (primary-source passage unverified)"}
              </div>
            </button>
          );
        })}
      </div>

      <div className={styles.subSectionTitle}>
        {isJa ? "具体的な確認項目（自由に編集可能）" : "Specific Inquiry Checklist (Fully Editable)"}
      </div>

      {CATEGORIES.map((cat) => {
        const catConditions = DIETARY_CONDITIONS.filter((c) => c.category === cat.id);
        return (
          <div key={cat.id} className={styles.categoryGroup}>
            <div className={styles.categoryTitle}>{isJa ? cat.labelJa : cat.labelEn}</div>
            <div className={styles.conditionList}>
              {catConditions.map((cond) => {
                const isChecked = selectedSet.has(cond.code);
                return (
                  <label key={cond.code} className={styles.conditionItem}>
                    <input
                      type="checkbox"
                      className={styles.conditionCheckbox}
                      checked={isChecked}
                      onChange={(event) => handleSetCondition(cond.code, event.currentTarget.checked)}
                      data-testid={`dietary-cond-${cond.code}`}
                    />
                    <div className={styles.conditionText}>
                      <span className={styles.conditionLabel}>
                        {isJa ? cond.labelJa : cond.labelEn}
                      </span>
                      <span className={styles.conditionDesc}>
                        {isJa ? cond.descriptionJa : cond.descriptionEn}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className={styles.actionRow}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={handleSelectAll}
            data-testid="dietary-select-all-btn"
          >
            {isJa ? "全条件を選択" : "Select All"}
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={handleClearAllConditions}
            data-testid="dietary-clear-all-btn"
          >
            {isJa ? "全条件を解除" : "Clear All"}
          </button>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={handleResetStorage}
            data-testid="dietary-reset-storage-btn"
          >
            {isJa ? "食事制約設定を消去" : "Reset Stored Conditions"}
          </button>
        </div>

        <button
          type="button"
          className={styles.btnPrimary}
          disabled={!canProceed || pending}
          onClick={onProceedToDietaryCard}
          data-testid="proceed-to-dietary-card-btn"
        >
          {isJa
            ? `店員向け確認カードへ進む (${settings.selectedConditions.length}項目)`
            : `Proceed to Staff Confirmation Card (${settings.selectedConditions.length})`}
        </button>
      </div>

      {clearedBanner && (
        <div className={styles.clearedAlert} role="status">
          {isJa
            ? "端末内に保存されていた食事制約設定を消去しました。"
            : "Stored dietary restrictions settings have been cleared from this device."}
        </div>
      )}

      {storageErrorBanner && (
        <div className={styles.errorAlert} role="alert" data-testid="dietary-storage-error-alert">
          {storageErrorBanner}
        </div>
      )}
    </section>
  );
}
