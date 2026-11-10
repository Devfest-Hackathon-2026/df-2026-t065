"use client";

import React from "react";
import type { AnalyzeMenuError } from "@/contracts/analyze";
import type { UiMessages } from "@/client/i18n";
import styles from "./AllergyBridgeApp.module.css";

export type ErrorBannerProps = {
  error: AnalyzeMenuError;
  messages: UiMessages;
  canRetrySameImage: boolean;
  onRetrySameImage: () => void;
  onRetakePhoto: () => void;
  onProceedToCardFallback: () => void;
};

export function ErrorBanner({
  error,
  messages,
  canRetrySameImage,
  onRetrySameImage,
  onRetakePhoto,
  onProceedToCardFallback,
}: ErrorBannerProps) {
  const e = messages.errors;
  const { code, retryable, reason } = error.error;

  const codeMsg = e.codeMessages[code];
  const reasonMsg = reason ? e.invalidReasonMessages[reason] : null;
  const hintMsg = retryable ? e.retryableHint : e.nonRetryableHint;

  return (
    <section
      className={styles.errorCard}
      role="alert"
      aria-labelledby="error-banner-title"
      data-testid="error-banner"
      data-error-code={code}
      data-error-reason={reason ?? ""}
    >
      <h2 id="error-banner-title" className={styles.errorTitle}>
        [!] {e.title} ({code})
      </h2>
      <p className={styles.errorBody} data-testid="error-code-message">
        {codeMsg}
      </p>
      {reasonMsg && (
        <p className={styles.errorBody} data-testid="error-reason-message">
          {reasonMsg}
        </p>
      )}
      <p className={styles.infoBoxBody} style={{ color: "#7f1d1d" }}>
        {hintMsg}
      </p>
      <p className={styles.infoBoxBody} style={{ fontSize: "0.78rem", marginTop: 4 }}>
        Request ID: {error.requestId}
      </p>

      <div className={styles.actionRow}>
        {retryable && canRetrySameImage && (
          <button
            type="button"
            onClick={onRetrySameImage}
            className={styles.primaryBtn}
            data-testid="error-retry-btn"
          >
            {e.retryBtn}
          </button>
        )}
        <button
          type="button"
          onClick={onRetakePhoto}
          className={styles.secondaryBtn}
          data-testid="error-retake-btn"
        >
          {e.retakeBtn}
        </button>
        <button
          type="button"
          onClick={onProceedToCardFallback}
          className={styles.primaryBtn}
          data-testid="error-card-fallback-btn"
        >
          {e.cardFallbackBtn}
        </button>
      </div>
    </section>
  );
}
