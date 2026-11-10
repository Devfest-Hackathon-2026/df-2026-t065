"use client";

import React, { useState } from "react";
import type { AllergenCode } from "@/contracts/allergens";
import type { AnalyzeMenuResponse, MenuItem } from "@/contracts/analyze";
import { getAllergenDualLabel, type UiMessages } from "@/client/i18n";
import {
  groupAssessmentsByCategory,
  organizeResultsByAllergen,
  splitTextByExcerpts,
} from "@/client/resultOrganizer";
import styles from "./AllergyBridgeApp.module.css";
import { ImageReconciliationView } from "./ImageReconciliationView";

export type ResultViewMode = "dish" | "allergen";

export type AnalysisResultSectionProps = {
  response: AnalyzeMenuResponse;
  userLang: string;
  storeLang: string;
  selectedAllergens: readonly AllergenCode[];
  previewUrl: string | null;
  originalPreviewUrl: string | null;
  selectedDishIdsForCard: readonly string[];
  messages: UiMessages;
  initialViewMode?: ResultViewMode;
  onToggleDishForCard: (dishId: string) => void;
  onProceedToConfirmCard: (specificDishId?: string) => void;
  onRetakePhoto: () => void;
};

export function AnalysisResultSection({
  response,
  userLang,
  storeLang,
  selectedAllergens,
  previewUrl,
  originalPreviewUrl,
  selectedDishIdsForCard,
  messages,
  initialViewMode = "dish",
  onToggleDishForCard,
  onProceedToConfirmCard,
  onRetakePhoto,
}: AnalysisResultSectionProps) {
  const r = messages.results;
  const [viewMode, setViewMode] = useState<ResultViewMode>(initialViewMode);
  const selectedDishSet = new Set(selectedDishIdsForCard);

  const statusText =
    response.status === "ok"
      ? r.statusOk
      : response.status === "partial"
        ? r.statusPartial
        : r.statusUnreadable;

  const statusClass =
    response.status === "ok"
      ? styles.statusBanner
      : response.status === "partial"
        ? `${styles.statusBanner} ${styles.statusBannerWarn}`
        : `${styles.statusBanner} ${styles.statusBannerError}`;

  const renderHighlightedReadText = (item: MenuItem) => {
    const excerpts = item.allergens
      .filter((a): a is Extract<(typeof item.allergens)[number], { category: "menu_mentions" }> => a.category === "menu_mentions")
      .map((a) => a.mention.excerpt);
    const segments = splitTextByExcerpts(item.readText.text, excerpts);
    return (
      <p className={styles.readTextContent} data-testid={`dish-read-text-${item.id}`}>
        {segments.map((seg, idx) =>
          seg.highlighted ? (
            <mark key={idx} className={styles.excerptHighlight}>
              {seg.text}
            </mark>
          ) : (
            <React.Fragment key={idx}>{seg.text}</React.Fragment>
          ),
        )}
      </p>
    );
  };

  const allergenGroups = organizeResultsByAllergen(response, selectedAllergens);

  return (
    <section className={styles.sectionCard} aria-labelledby="results-section-title" data-testid="results-section">
      <h2 id="results-section-title" className={styles.sectionTitle}>
        {r.sectionTitle}
      </h2>

      {/* 1. Mock Data Banner (Mandatory when dataOrigin === "mock_fixture") */}
      {response.dataOrigin === "mock_fixture" && (
        <div className={styles.mockBanner} role="note" data-testid="mock-fixture-banner">
          <p className={styles.mockBannerTitle}>{r.mockDataBannerTitle}</p>
          <p className={styles.mockBannerBody}>{r.mockDataBannerBody}</p>
        </div>
      )}

      {/* 2. Overall Analysis Status & Image Issues */}
      <div className={statusClass} role="status" data-testid="analysis-status-banner" data-status={response.status}>
        <div>{statusText}</div>
        {response.imageIssues.length > 0 && (
          <div data-testid="image-issues-list">
            <div style={{ marginTop: 6 }}>{r.imageIssuesTitle}:</div>
            <ul className={styles.issueList}>
              {response.imageIssues.map((issue) => (
                <li key={issue} data-testid={`image-issue-${issue}`}>
                  {r.imageIssueLabels[issue]}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 3. Side-by-side / Collapsible Original Menu Photo Comparison */}
      <div className={styles.previewBox} data-testid="image-comparison-panel">
        <ImageReconciliationView
          originalPreviewUrl={originalPreviewUrl}
          processedPreviewUrl={previewUrl}
          messages={r}
        />
      </div>

      {/* 4. Menu-Wide Notices (e.g. shared fryer) */}
      {response.menuNotices.length > 0 && (
        <div className={styles.fieldGroup} data-testid="menu-notices-section">
          <h3 className={styles.fieldLabel}>{r.menuNoticesTitle}</h3>
          <p className={styles.fieldHelp}>{r.menuNoticesHelp}</p>
          {response.menuNotices.map((notice) => (
            <div key={notice.id} className={styles.noticeCard} data-testid={`menu-notice-${notice.id}`}>
              <div className={styles.readTextLabel}>
                [AI] {r.aiMisreadWarning} (readBy: {notice.readText.readBy})
              </div>
              <p className={styles.readTextContent}>{notice.readText.text}</p>
              {notice.aiTranslation && (
                <p className={styles.translationRow}>
                  <span className={styles.readTextLabel} style={{ marginRight: 6 }}>
                    {r.unverifiedTranslationBadge}
                  </span>
                  {notice.aiTranslation.text}
                </p>
              )}
              <div className={styles.badgeRow}>
                {notice.mentions.map((m) => (
                  <span key={`${notice.id}-${m.code}`} className={styles.mentionKindTag}>
                    {getAllergenDualLabel(m.code, userLang, storeLang)} — {r.mentionKindBadges[m.kind]}
                  </span>
                ))}
              </div>
              {notice.mentions.some((m) => m.kind === "absence_claim") && (
                <div className={styles.absenceWarningBox} role="note" data-testid="notice-absence-claim-warning">
                  {r.absenceClaimWarning}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 5. View Switcher: By Dish vs By Allergen */}
      {response.items.length > 0 && (
        <div className={styles.viewSwitcher} role="tablist" aria-label={r.viewModeLabel}>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "dish"}
            onClick={() => setViewMode("dish")}
            className={`${styles.viewTabBtn} ${viewMode === "dish" ? styles.viewTabBtnActive : ""}`}
            data-testid="view-by-dish-btn"
          >
            {r.viewByDish}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "allergen"}
            onClick={() => setViewMode("allergen")}
            className={`${styles.viewTabBtn} ${viewMode === "allergen" ? styles.viewTabBtnActive : ""}`}
            data-testid="view-by-allergen-btn"
          >
            {r.viewByAllergen}
          </button>
        </div>
      )}

      {/* Empty / Unreadable Items State */}
      {response.items.length === 0 && (
        <div className={styles.infoBoxWarning} role="note" data-testid="no-items-message">
          <p className={styles.infoBoxBody} style={{ fontWeight: 700 }}>
            {r.noItemsMessage}
          </p>
        </div>
      )}

      {/* 6A. By Dish View */}
      {response.items.length > 0 && viewMode === "dish" && (
        <div data-testid="dish-view-container">
          {response.items.map((item) => {
            const grouped = groupAssessmentsByCategory(item.allergens);
            const isSelectedForCard = selectedDishSet.has(item.id);

            return (
              <article key={item.id} className={styles.dishCard} data-testid={`dish-card-${item.id}`}>
                <div className={styles.dishHeader}>
                  <div className={styles.readTextBlock}>
                    <span className={styles.readTextLabel}>
                      [AI] {r.aiMisreadWarning} (readBy: {item.readText.readBy}
                      {item.readText.lang ? `, lang: ${item.readText.lang}` : ""})
                    </span>
                    {renderHighlightedReadText(item)}
                    {item.aiTranslation && (
                      <div className={styles.translationRow} data-testid={`dish-translation-${item.id}`}>
                        <span className={styles.readTextLabel} style={{ marginRight: 6 }}>
                          {r.unverifiedTranslationBadge}
                        </span>
                        <span>{item.aiTranslation.text}</span>
                      </div>
                    )}
                  </div>

                  <div className={styles.allergenHeaderRow}>
                    <span className={styles.metaBadge}>
                      {item.readability === "clear" ? r.readabilityClear : `[!] ${r.readabilityPartial}`}
                    </span>

                    <label className={styles.allergenCheckboxRow} style={{ cursor: "pointer", fontSize: "0.88rem" }}>
                      <input
                        type="checkbox"
                        checked={isSelectedForCard}
                        onChange={() => onToggleDishForCard(item.id)}
                        className={styles.checkboxInput}
                        data-testid={`select-dish-checkbox-${item.id}`}
                      />
                      <span>{r.askStaffForDishBtn}</span>
                    </label>
                  </div>
                </div>

                {/* Category 1: menu_mentions */}
                {grouped.menu_mentions.length > 0 && (
                  <div
                    className={`${styles.categorySection} ${styles.categoryMenuMentions}`}
                    data-testid={`dish-${item.id}-category-menu_mentions`}
                  >
                    <h4 className={styles.categoryHeader}>{r.categoryTitles.menu_mentions}</h4>
                    <p className={styles.categoryDesc}>{r.categoryDescriptions.menu_mentions}</p>
                    {grouped.menu_mentions.map((a) => (
                      <div
                        key={a.code}
                        className={styles.assessmentItem}
                        data-testid={`assessment-${item.id}-${a.code}`}
                        data-category="menu_mentions"
                        data-mention-kind={a.mention.kind}
                      >
                        <div className={styles.assessmentTopRow}>
                          <span className={styles.allergenTitle}>
                            [!] {getAllergenDualLabel(a.code, userLang, storeLang)}
                          </span>
                          <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                        </div>
                        <div className={styles.mentionKindTag} data-testid={`mention-kind-${item.id}-${a.code}`}>
                          {r.mentionKindBadges[a.mention.kind]}
                        </div>
                        <p className={styles.detailText}>{r.mentionKindDescriptions[a.mention.kind]}</p>
                        <p className={styles.detailText} data-testid={`excerpt-${item.id}-${a.code}`}>
                          <strong>{r.excerptLabel}:</strong> &ldquo;{a.mention.excerpt}&rdquo;
                        </p>
                        {a.mention.kind === "absence_claim" && (
                          <div
                            className={styles.absenceWarningBox}
                            role="note"
                            data-testid={`absence-claim-warning-${item.id}-${a.code}`}
                          >
                            {r.absenceClaimWarning}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Category 2: ai_inferred */}
                {grouped.ai_inferred.length > 0 && (
                  <div
                    className={`${styles.categorySection} ${styles.categoryAiInferred}`}
                    data-testid={`dish-${item.id}-category-ai_inferred`}
                  >
                    <h4 className={styles.categoryHeader}>{r.categoryTitles.ai_inferred}</h4>
                    <p className={styles.categoryDesc}>{r.categoryDescriptions.ai_inferred}</p>
                    {grouped.ai_inferred.map((a) => (
                      <div
                        key={a.code}
                        className={styles.assessmentItem}
                        data-testid={`assessment-${item.id}-${a.code}`}
                        data-category="ai_inferred"
                      >
                        <div className={styles.assessmentTopRow}>
                          <span className={styles.allergenTitle}>
                            [?] {getAllergenDualLabel(a.code, userLang, storeLang)}
                          </span>
                          <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                        </div>
                        {a.rationale && (
                          <p className={styles.detailText} data-testid={`rationale-${item.id}-${a.code}`}>
                            <strong>{r.rationaleLabel}:</strong> {a.rationale}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Category 3: unconfirmed */}
                {grouped.unconfirmed.length > 0 && (
                  <div
                    className={`${styles.categorySection} ${styles.categoryUnconfirmed}`}
                    data-testid={`dish-${item.id}-category-unconfirmed`}
                  >
                    <h4 className={styles.categoryHeader}>{r.categoryTitles.unconfirmed}</h4>
                    <p className={styles.categoryDesc}>{r.categoryDescriptions.unconfirmed}</p>
                    {grouped.unconfirmed.map((a) => (
                      <div
                        key={a.code}
                        className={styles.assessmentItem}
                        data-testid={`assessment-${item.id}-${a.code}`}
                        data-category="unconfirmed"
                        data-unconfirmed-reason={a.reason}
                      >
                        <div className={styles.assessmentTopRow}>
                          <span className={styles.allergenTitle}>
                            [未確認 / UNCONFIRMED] {getAllergenDualLabel(a.code, userLang, storeLang)}
                          </span>
                          <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                        </div>
                        <p className={styles.detailText}>{r.unconfirmedReasonLabels[a.reason]}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={() => onProceedToConfirmCard(item.id)}
                    className={styles.smallBtn}
                    data-testid={`ask-staff-dish-btn-${item.id}`}
                  >
                    {r.askStaffForDishBtn}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 6B. By Allergen View */}
      {response.items.length > 0 && viewMode === "allergen" && (
        <div data-testid="allergen-view-container">
          {allergenGroups.map((group) => (
            <article
              key={group.code}
              className={styles.dishCard}
              data-testid={`allergen-group-card-${group.code}`}
            >
              <div className={styles.dishHeader}>
                <h3 className={styles.sectionTitle} style={{ marginBottom: 0 }}>
                  {getAllergenDualLabel(group.code, userLang, storeLang)}
                </h3>
              </div>

              {/* Category 1: menu_mentions */}
              {group.menu_mentions.length > 0 && (
                <div className={`${styles.categorySection} ${styles.categoryMenuMentions}`}>
                  <h4 className={styles.categoryHeader}>{r.categoryTitles.menu_mentions}</h4>
                  {group.menu_mentions.map(({ item, assessment }) => (
                    <div key={item.id} className={styles.assessmentItem}>
                      <div className={styles.assessmentTopRow}>
                        <span className={styles.allergenTitle}>{item.readText.text}</span>
                        <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                      </div>
                      <div className={styles.mentionKindTag}>
                        {r.mentionKindBadges[assessment.mention.kind]}
                      </div>
                      <p className={styles.detailText}>
                        <strong>{r.excerptLabel}:</strong> &ldquo;{assessment.mention.excerpt}&rdquo;
                      </p>
                      {assessment.mention.kind === "absence_claim" && (
                        <div className={styles.absenceWarningBox} role="note">
                          {r.absenceClaimWarning}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Category 2: ai_inferred */}
              {group.ai_inferred.length > 0 && (
                <div className={`${styles.categorySection} ${styles.categoryAiInferred}`}>
                  <h4 className={styles.categoryHeader}>{r.categoryTitles.ai_inferred}</h4>
                  {group.ai_inferred.map(({ item, assessment }) => (
                    <div key={item.id} className={styles.assessmentItem}>
                      <div className={styles.assessmentTopRow}>
                        <span className={styles.allergenTitle}>{item.readText.text}</span>
                        <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                      </div>
                      {assessment.rationale && (
                        <p className={styles.detailText}>
                          <strong>{r.rationaleLabel}:</strong> {assessment.rationale}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Category 3: unconfirmed */}
              {group.unconfirmed.length > 0 && (
                <div className={`${styles.categorySection} ${styles.categoryUnconfirmed}`}>
                  <h4 className={styles.categoryHeader}>{r.categoryTitles.unconfirmed}</h4>
                  {group.unconfirmed.map(({ item, assessment }) => (
                    <div key={item.id} className={styles.assessmentItem}>
                      <div className={styles.assessmentTopRow}>
                        <span className={styles.allergenTitle}>{item.readText.text}</span>
                        <span className={styles.confirmRequiredTag}>{r.confirmationRequiredBadge}</span>
                      </div>
                      <p className={styles.detailText}>{r.unconfirmedReasonLabels[assessment.reason]}</p>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* 7. Bottom Actions */}
      <div className={styles.actionRow}>
        <button
          type="button"
          onClick={() => onProceedToConfirmCard()}
          className={styles.primaryBtn}
          data-testid="results-to-card-btn"
        >
          {r.askStaffSelectedBtn(selectedDishIdsForCard.length)}
        </button>
        <button
          type="button"
          onClick={onRetakePhoto}
          className={styles.secondaryBtn}
          data-testid="results-retake-btn"
        >
          {r.retakePhotoBtn}
        </button>
      </div>
    </section>
  );
}
