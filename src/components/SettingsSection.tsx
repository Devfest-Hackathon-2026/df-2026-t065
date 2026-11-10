"use client";

import React from "react";
import { ALLERGEN_CODES, type AllergenCode } from "@/contracts/allergens";
import type { LanguagePair } from "@/contracts/analyze";
import { getAllergenLabel, type UiMessages } from "@/client/i18n";
import styles from "./AllergyBridgeApp.module.css";

export type SettingsSectionProps = {
  messages: UiMessages;
  userLang: string;
  storeLang: string;
  selectedAllergens: readonly AllergenCode[];
  settingsClearedBanner: boolean;
  onSelectLanguagePair: (pair: LanguagePair) => void;
  onToggleAllergen: (code: AllergenCode) => void;
  onSelectAllAllergens: () => void;
  onClearAllAllergens: () => void;
  onClearStoredSettings: () => void;
  onProceedToUpload: () => void;
  onGoToCardDirectly: () => void;
};

export function SettingsSection({
  messages,
  userLang,
  storeLang,
  selectedAllergens,
  settingsClearedBanner,
  onSelectLanguagePair,
  onToggleAllergen,
  onSelectAllAllergens,
  onClearAllAllergens,
  onClearStoredSettings,
  onProceedToUpload,
  onGoToCardDirectly,
}: SettingsSectionProps) {
  const s = messages.settings;
  const selectedSet = new Set(selectedAllergens);
  const canProceed = selectedAllergens.length > 0;

  // Selecting userLang pairs automatically with the supported opposite storeLang (MVP: ja<->en)
  const handleSelectUserLang = (nextUserLang: "ja" | "en") => {
    const nextStoreLang = nextUserLang === "ja" ? "en" : "ja";
    onSelectLanguagePair({ userLang: nextUserLang, storeLang: nextStoreLang });
  };

  // Selecting storeLang pairs automatically with the supported opposite userLang (MVP: ja<->en)
  const handleSelectStoreLang = (nextStoreLang: "ja" | "en") => {
    const nextUserLang = nextStoreLang === "ja" ? "en" : "ja";
    onSelectLanguagePair({ userLang: nextUserLang, storeLang: nextStoreLang });
  };

  return (
    <section className={styles.sectionCard} aria-labelledby="settings-section-title" data-testid="settings-section">
      <h2 id="settings-section-title" className={styles.sectionTitle}>
        {s.sectionTitle}
      </h2>

      {/* 1. Separated Language Selectors (Button Selection UI) */}
      <div className={styles.fieldGroup}>
        <div className={styles.langSelectorGrid}>
          {/* Tool Language: Label "Language", Buttons "日本語" / "English" */}
          <div className={styles.langSelectorBox} role="group" aria-labelledby="user-lang-group-label" data-testid="user-lang-selector">
            <span id="user-lang-group-label" className={styles.fieldLabel} style={{ marginBottom: 0 }}>
              {s.userLangLabel}
            </span>
            <div className={styles.langButtonGroup}>
              <button
                type="button"
                aria-pressed={userLang === "ja"}
                onClick={() => handleSelectUserLang("ja")}
                className={`${styles.langChoiceBtn} ${userLang === "ja" ? styles.langChoiceBtnActive : ""}`}
                data-testid="user-lang-btn-ja"
              >
                {s.langBtnJa}
              </button>
              <button
                type="button"
                aria-pressed={userLang === "en"}
                onClick={() => handleSelectUserLang("en")}
                className={`${styles.langChoiceBtn} ${userLang === "en" ? styles.langChoiceBtnActive : ""}`}
                data-testid="user-lang-btn-en"
              >
                {s.langBtnEn}
              </button>
            </div>
          </div>

          {/* Store Language: Label "店舗で使用されている言語", Buttons "日本語" / "English" */}
          <div className={styles.langSelectorBox} role="group" aria-labelledby="store-lang-group-label" data-testid="store-lang-selector">
            <span id="store-lang-group-label" className={styles.fieldLabel} style={{ marginBottom: 0 }}>
              {s.storeLangLabel}
            </span>
            <div className={styles.langButtonGroup}>
              <button
                type="button"
                aria-pressed={storeLang === "ja"}
                onClick={() => handleSelectStoreLang("ja")}
                className={`${styles.langChoiceBtn} ${storeLang === "ja" ? styles.langChoiceBtnActive : ""}`}
                data-testid="store-lang-btn-ja"
              >
                {s.langBtnJa}
              </button>
              <button
                type="button"
                aria-pressed={storeLang === "en"}
                onClick={() => handleSelectStoreLang("en")}
                className={`${styles.langChoiceBtn} ${storeLang === "en" ? styles.langChoiceBtnActive : ""}`}
                data-testid="store-lang-btn-en"
              >
                {s.langBtnEn}
              </button>
            </div>
          </div>
        </div>
        <p className={styles.fieldHelp} style={{ marginBottom: 0 }}>
          {s.pairAutoNote}
        </p>
      </div>

      {/* 2. 11 Allergen Checkboxes (concise, with shortened fish note) */}
      <div className={styles.fieldGroup}>
        <div className={styles.allergenHeaderRow}>
          <span className={styles.fieldLabel} style={{ marginBottom: 0 }}>
            {s.allergensLabel}
          </span>
          <div className={styles.quickActionRow}>
            <span className={styles.selectedCountBadge} data-testid="selected-allergen-count">
              {s.selectedCount(selectedAllergens.length)}
            </span>
            <button
              type="button"
              onClick={onSelectAllAllergens}
              className={styles.smallBtn}
              data-testid="select-all-allergens-btn"
            >
              {s.selectAll}
            </button>
            <button
              type="button"
              onClick={onClearAllAllergens}
              className={styles.smallBtn}
              data-testid="clear-all-allergens-btn"
            >
              {s.clearAll}
            </button>
          </div>
        </div>

        <div className={styles.allergenGrid} role="group" aria-label={s.allergensLabel}>
          {ALLERGEN_CODES.map((code) => {
            const isChecked = selectedSet.has(code);
            const primaryLabel = getAllergenLabel(code, userLang);
            const secondaryLabel = getAllergenLabel(code, storeLang);

            return (
              <label
                key={code}
                className={`${styles.allergenCard} ${isChecked ? styles.allergenCardSelected : ""}`}
                data-testid={`allergen-option-${code}`}
              >
                <div className={styles.allergenCheckboxRow}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggleAllergen(code)}
                    className={styles.checkboxInput}
                  />
                  <span>{primaryLabel}</span>
                </div>
                <span className={styles.allergenSubLabel}>{secondaryLabel}</span>
                {code === "fish" && (
                  <div className={styles.scopeNoteBox} role="note" data-testid="scope-note-fish">
                    {s.fishShortNote}
                  </div>
                )}
              </label>
            );
          })}
        </div>
      </div>

      {/* 3. Always-Visible Critical Disclaimer: Assessment Scope & Unsupported Allergens */}
      <div className={styles.infoBoxWarning} role="note" data-testid="unsupported-allergens-notice">
        <p className={styles.infoBoxTitle}>[!] {s.unsupportedAllergensTitle}</p>
        <p className={styles.infoBoxBody}>{s.unsupportedAllergensBody}</p>
      </div>

      {/* 4. Compact Device-Only Storage Bar (full details in top-right Specs modal) */}
      <div className={styles.storageCompactBar} role="note" data-testid="device-storage-notice">
        <span>{s.storageShortNote}</span>
        <button
          type="button"
          onClick={onClearStoredSettings}
          className={styles.smallBtn}
          data-testid="reset-stored-settings-btn"
        >
          {s.clearSavedSettings}
        </button>
        {settingsClearedBanner && (
          <span role="status" style={{ fontWeight: 700, color: "#0f172a", width: "100%" }}>
            {s.settingsClearedNotice}
          </span>
        )}
      </div>

      {!canProceed && (
        <p role="alert" style={{ color: "#b91c1c", fontWeight: 700, fontSize: "0.9rem" }} data-testid="allergen-required-hint">
          {s.selectAtLeastOneAllergen}
        </p>
      )}

      {/* 5. Primary Navigation Actions */}
      <div className={styles.actionRow}>
        <button
          type="button"
          onClick={onProceedToUpload}
          disabled={!canProceed}
          className={styles.primaryBtn}
          data-testid="proceed-to-upload-btn"
        >
          {s.proceedToUpload}
        </button>
        <button
          type="button"
          onClick={onGoToCardDirectly}
          disabled={!canProceed}
          className={styles.secondaryBtn}
          data-testid="go-to-card-directly-btn"
        >
          {s.goToCardDirectly}
        </button>
      </div>
    </section>
  );
}
