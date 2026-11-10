"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  buildDietaryConfirmationCardBundle,
  type BilingualDietaryPhrase,
} from "@/client/dietaryPhrases";
import type { DietaryConditionCode } from "@/contracts/dietary";
import styles from "./DietaryConfirmationCard.module.css";

export type DietaryConfirmationCardProps = {
  userLang: string;
  storeLang: string;
  selectedConditions: readonly DietaryConditionCode[];
  onBackToSettings: () => void;
};

type AnswerType = "yes" | "no" | "unknown";

export function DietaryConfirmationCard({
  userLang,
  storeLang,
  selectedConditions,
  onBackToSettings,
}: DietaryConfirmationCardProps) {
  const isJaUser = userLang === "ja";
  const [isPresentation, setIsPresentation] = useState(false);
  const [answers, setAnswers] = useState<Record<string, AnswerType>>({});
  const cardHeadingId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const presentationBtnRef = useRef<HTMLButtonElement | null>(null);

  // Focus heading on mount for accessible navigation (MINOR-2)
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Keyboard trap / Escape support for presentation mode (MINOR-2)
  useEffect(() => {
    if (!isPresentation) return;
    const container = containerRef.current;
    if (!container) return;
    const changed: { element: HTMLElement; inert: boolean }[] = [];
    let child: HTMLElement = container;
    while (child.parentElement && child.parentElement !== document.body) {
      for (const sibling of child.parentElement.children) {
        if (sibling !== child && sibling instanceof HTMLElement) {
          changed.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      child = child.parentElement;
    }
    presentationBtnRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const elements = Array.from(container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex="0"]',
        ));
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (e.shiftKey ? document.activeElement === first || !container.contains(document.activeElement)
          : document.activeElement === last || !container.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
      if (e.key === "Escape") {
        setIsPresentation(false);
        presentationBtnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      changed.forEach(({ element, inert }) => { element.inert = inert; });
    };
  }, [isPresentation]);

  const bundle = buildDietaryConfirmationCardBundle({
    userLang,
    storeLang,
    selectedConditions,
  });

  const handleSelectAnswer = (questionId: string, answerType: AnswerType) => {
    setAnswers((prev) => {
      if (prev[questionId] === answerType) {
        // Toggle off if already selected
        const next = { ...prev };
        delete next[questionId];
        return next;
      }
      return {
        ...prev,
        [questionId]: answerType,
      };
    });
  };

  const handleResetAnswers = () => {
    setAnswers({});
  };

  const handleTogglePresentation = () => {
    setIsPresentation((prev) => {
      const next = !prev;
      if (!next) {
        setTimeout(() => presentationBtnRef.current?.focus(), 0);
      }
      return next;
    });
  };

  if (!bundle.supportedPair) {
    return (
      <div className={styles.cardContainer} role="region" aria-label="Dietary confirmation card">
        <div className={styles.topBar}>
          <button type="button" className={styles.btnAction} onClick={onBackToSettings}>
            {isJaUser ? "← 設定に戻る" : "← Back to Settings"}
          </button>
        </div>
        <p className={styles.safetyNotice} role="alert">
          {isJaUser
            ? "現在、食事制約カードは日本語と英語の組み合わせのみ検証されています。"
            : "Currently, dietary inquiry cards are only verified for Japanese and English."}
        </p>
      </div>
    );
  }

  const yesOption = bundle.staffAnswerOptions.find((p) => p.id === "DIETARY_ANS_YES");
  const noOption = bundle.staffAnswerOptions.find((p) => p.id === "DIETARY_ANS_NO");
  const unknownOption = bundle.staffAnswerOptions.find((p) => p.id === "DIETARY_ANS_UNKNOWN");

  return (
    <div
      className={`${styles.cardContainer} ${isPresentation ? styles.presentationMode : ""}`}
      ref={containerRef}
      data-testid="dietary-confirmation-card"
      role={isPresentation ? "dialog" : "region"}
      aria-modal={isPresentation ? true : undefined}
      aria-labelledby={cardHeadingId}
    >
      <div className={styles.topBar}>
        <div>
          <h2
            id={cardHeadingId}
            ref={headingRef}
            tabIndex={-1}
            className={styles.cardTitle}
            style={{ outline: "none" }}
          >
            {storeLang === "ja"
              ? "店員向け食事制約・条件確認カード"
              : "Staff Dietary Restriction Inquiry Card"}
          </h2>
          <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
            {userLang.toUpperCase()} → {storeLang.toUpperCase()}
          </span>
        </div>

        <div className={styles.topActions}>
          <button
            type="button"
            ref={presentationBtnRef}
            className={styles.btnAction}
            onClick={handleTogglePresentation}
            data-testid="dietary-toggle-presentation-btn"
          >
            {isPresentation
              ? isJaUser
                ? "通常表示に戻す"
                : "Exit Full Screen"
              : isJaUser
              ? "📱 店員に見せる（拡大表示）"
              : "📱 Present to Staff"}
          </button>
          <button
            type="button"
            className={styles.btnAction}
            onClick={handleResetAnswers}
            data-testid="dietary-reset-answers-btn"
          >
            {isJaUser ? "回答をリセット" : "Reset Answers"}
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={onBackToSettings}
            data-testid="dietary-back-settings-btn"
          >
            {isJaUser ? "← 設定に戻る" : "← Back to Settings"}
          </button>
        </div>
      </div>

      <div className={styles.safetyNotice} role="note">
        <strong>
          {isJaUser
            ? "【確認カードの安全性について】"
            : "[Notice regarding Inquiry Cards]"}
        </strong>
        <br />
        {isJaUser
          ? "このカードは利用者が指定した確認項目を店員に質問するためのものです。本アプリは料理の適合や安全を保証するものではありません。"
          : "This card is designed to ask restaurant staff about customer-specified ingredients and cooking methods. The app does not certify compliance or food safety."}
      </div>

      {bundle.staffAnswerOptions.length !== 3 && (
        <p role="alert" data-testid="dietary-unverified-answers">
          {isJaUser ? "未確認の回答ラベルは表示していません。" : "Unreviewed answer labels are not displayed."}
        </p>
      )}
      {/* Explicit warning for unverified conditions */}
      {bundle.unverifiedConditions.length > 0 && (
        <div className={styles.unverifiedWarning} role="alert" data-testid="dietary-unverified-warning">
          <strong>{isJaUser ? "【未確認の条件】" : "[Unverified Conditions]"}</strong>
          <p style={{ margin: "4px 0 0 0" }}>
            {isJaUser
              ? `以下の条件は検証済み翻訳がないためカードに含まれていません: ${bundle.unverifiedConditions.join(", ")}`
              : `The following conditions are omitted because verified translations are unavailable: ${bundle.unverifiedConditions.join(", ")}`}
          </p>
        </div>
      )}

      {bundle.noticePhrases.map((notice: BilingualDietaryPhrase) => (
        <div key={notice.id} className={styles.noticeBox} data-testid="dietary-notice-box">
          <div className={styles.noticeStoreText}>{notice.storeText}</div>
          <div className={styles.noticeUserText}>（{notice.userText}）</div>
        </div>
      ))}

      <div className={styles.questionsContainer}>
        {bundle.conditionQuestions.map((q: BilingualDietaryPhrase, index: number) => {
          const selectedAnswer = answers[q.id];

          // Every answer, including compliance questions, comes from reviewed data.
          // Generic Yes/No answers refer only to the exact displayed question.
          const yesStoreText = yesOption?.storeText;
          const yesUserText = yesOption?.userText;
          const noStoreText = noOption?.storeText;
          const noUserText = noOption?.userText;

          return (
            <div
              key={q.id}
              className={styles.questionCard}
              data-testid={`dietary-question-${q.conditionCode}`}
            >
              <div className={styles.questionNum}>質問 {index + 1}</div>
              <div className={styles.questionStoreText}>{q.storeText}</div>
              <div className={styles.questionUserText}>（{q.userText}）</div>

              <div className={styles.answerRow}>
                {yesOption && (
                  <button
                    type="button"
                    className={`${styles.answerBtn} ${
                      selectedAnswer === "yes" ? styles.answerBtnSelectedYes : ""
                    }`}
                    onClick={() => handleSelectAnswer(q.id, "yes")}
                    aria-pressed={selectedAnswer === "yes"}
                    data-testid={`dietary-ans-yes-${q.id}`}
                  >
                    <span className={styles.answerBtnStore}>{yesStoreText}</span>
                    <span className={styles.answerBtnUser}>{yesUserText}</span>
                  </button>
                )}

                {noOption && (
                  <button
                    type="button"
                    className={`${styles.answerBtn} ${
                      selectedAnswer === "no" ? styles.answerBtnSelectedNo : ""
                    }`}
                    onClick={() => handleSelectAnswer(q.id, "no")}
                    aria-pressed={selectedAnswer === "no"}
                    data-testid={`dietary-ans-no-${q.id}`}
                  >
                    <span className={styles.answerBtnStore}>{noStoreText}</span>
                    <span className={styles.answerBtnUser}>{noUserText}</span>
                  </button>
                )}

                {unknownOption && (
                  <button
                    type="button"
                    className={`${styles.answerBtn} ${
                      selectedAnswer === "unknown" ? styles.answerBtnSelectedUnknown : ""
                    }`}
                    onClick={() => handleSelectAnswer(q.id, "unknown")}
                    aria-pressed={selectedAnswer === "unknown"}
                    data-testid={`dietary-ans-unknown-${q.id}`}
                  >
                    <span className={styles.answerBtnStore}>{unknownOption.storeText}</span>
                    <span className={styles.answerBtnUser}>{unknownOption.userText}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.verificationFooter}>
        <span>検証記録のある固定文言のみ表示（未確認項目は省略）</span>
        <span>•</span>
        <span>機械翻訳による自動生成文ではありません</span>
      </div>
    </div>
  );
}
