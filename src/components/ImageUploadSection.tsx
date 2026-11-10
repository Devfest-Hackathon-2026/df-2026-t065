"use client";

import React, { useRef } from "react";
import { IMAGE_CONSTRAINTS } from "@/contracts/analyze";
import {
  DEV_MOCK_SCENARIOS,
  isDevMockPanelAllowed,
  type DevMockScenarioId,
} from "@/client/analyzeClient";
import {
  areCropRectsEqual,
  createFullCropRect,
  type PixelCropRect,
} from "@/client/imageCropGeometry";
import type { ProcessedMenuImage } from "@/client/imageProcessor";
import { formatByteSize } from "@/client/resultOrganizer";
import type { UiLang, UiMessages } from "@/client/i18n";
import { ImageCropEditor } from "./ImageCropEditor";
import styles from "./AllergyBridgeApp.module.css";

const NOOP = () => {};

export type ImageUploadSectionProps = {
  analysisAvailable?: boolean;
  uiLang: UiLang;
  messages: UiMessages;
  processedImage: ProcessedMenuImage | null;
  previewUrl: string | null;
  baseImage?: ProcessedMenuImage | null;
  basePreviewUrl?: string | null;
  draftCropRect?: PixelCropRect | null;
  appliedCropRect?: PixelCropRect | null;
  isCropEditorOpen?: boolean;
  isProcessingImage: boolean;
  isAnalyzing: boolean;
  isOffline?: boolean;
  mockScenario: DevMockScenarioId;
  nodeEnv?: string;
  onSelectFile: (file: File | null) => void;
  onChangeDraftCrop?: (nextRect: PixelCropRect) => void;
  onApplyCrop?: () => void;
  onResetCrop?: () => void;
  onUseOriginalImage?: () => void;
  onCancelCropEdit?: () => void;
  onOpenCropEditor?: () => void;
  onChangeMockScenario: (scenario: DevMockScenarioId) => void;
  onAnalyze: () => void;
  onClearImage: () => void;
  onBackToSettings: () => void;
  onGoToCardDirectly: () => void;
};

export function ImageUploadSection({
  analysisAvailable = false,
  uiLang,
  messages,
  processedImage,
  previewUrl,
  baseImage,
  basePreviewUrl,
  draftCropRect,
  appliedCropRect,
  isCropEditorOpen = true,
  isProcessingImage,
  isAnalyzing,
  isOffline = false,
  mockScenario,
  nodeEnv,
  onSelectFile,
  onChangeDraftCrop = NOOP,
  onApplyCrop = NOOP,
  onResetCrop = NOOP,
  onUseOriginalImage = NOOP,
  onCancelCropEdit = NOOP,
  onOpenCropEditor = NOOP,
  onChangeMockScenario,
  onAnalyze,
  onClearImage,
  onBackToSettings,
  onGoToCardDirectly,
}: ImageUploadSectionProps) {
  const u = messages.upload;
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const acceptTypes = IMAGE_CONSTRAINTS.mimeTypes.join(",");
  const showDevMockSelector = isDevMockPanelAllowed(nodeEnv);
  // Keep file selection enabled during crop/image processing so user can switch image mid-edit/mid-process
  const inputDisabled = !analysisAvailable || isAnalyzing;
  // Applied last: unavailable analysis must override both eligibility and onClick.
  const unavailableAnalysisProps = analysisAvailable ? {} : { disabled: true, onClick: undefined };

  const effectiveBaseImage = baseImage !== undefined ? baseImage : processedImage;
  const effectiveBasePreviewUrl = basePreviewUrl !== undefined ? basePreviewUrl : previewUrl;

  const defaultFullRect = effectiveBaseImage
    ? createFullCropRect(effectiveBaseImage.width, effectiveBaseImage.height)
    : null;
  const effectiveDraftCrop = draftCropRect ?? defaultFullRect;
  const effectiveAppliedCrop = appliedCropRect ?? defaultFullRect;

  const hasUnappliedCropChange = Boolean(
    effectiveDraftCrop &&
      effectiveAppliedCrop &&
      !areCropRectsEqual(effectiveDraftCrop, effectiveAppliedCrop),
  );

  const isCropped = Boolean(processedImage?.cropped);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (inputDisabled) return;
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    onSelectFile(file);
  };

  const triggerCameraPicker = () => {
    if (inputDisabled || !cameraInputRef.current) return;
    cameraInputRef.current.value = "";
    cameraInputRef.current.click();
  };

  const triggerFilePicker = () => {
    if (inputDisabled || !fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  return (
    <section className={styles.sectionCard} aria-labelledby="upload-section-title" data-testid="upload-section">
      <h2 id="upload-section-title" className={styles.sectionTitle}>
        {u.sectionTitle}
      </h2>
      <p className={styles.sectionHelp}>{u.shortFormatHint}</p>

      {/* Shooting Guide (Concise pre-capture & upload guidance in JA/EN) */}
      <aside
        className={styles.shootingGuideBox}
        aria-labelledby="shooting-guide-title"
        data-testid="shooting-guide-box"
      >
        <h3 id="shooting-guide-title" className={styles.shootingGuideTitle} data-testid="shooting-guide-title">
          [Guide] {u.shootingGuideTitle}
        </h3>
        <ul className={styles.shootingGuideList} data-testid="shooting-guide-list">
          {u.shootingGuideItems.map((item, idx) => (
            <li key={idx} data-testid={`shooting-guide-item-${idx}`}>
              {item}
            </li>
          ))}
        </ul>
      </aside>

      {/* Camera & File Selection Controls (Keyboard-accessible buttons + labeled file inputs) */}
      <div className={styles.uploadControlsGrid}>
        <div>
          <button
            type="button"
            onClick={triggerCameraPicker}
            disabled={inputDisabled}
            aria-controls="camera-file-input"
            className={styles.fileButtonLabel}
            data-testid="camera-capture-btn"
          >
            <span>[Camera] {u.takePhotoBtn}</span>
          </button>
          <label
            htmlFor="camera-file-input"
            className={styles.visuallyHiddenFileInput}
            data-testid="camera-capture-label"
          >
            {u.takePhotoBtn}
          </label>
          <input
            id="camera-file-input"
            ref={cameraInputRef}
            type="file"
            accept={acceptTypes}
            capture="environment"
            tabIndex={-1}
            onChange={handleInputChange}
            disabled={inputDisabled}
            className={styles.visuallyHiddenFileInput}
            data-testid="camera-file-input"
          />
        </div>

        <div>
          <button
            type="button"
            onClick={triggerFilePicker}
            disabled={inputDisabled}
            aria-controls="upload-file-input"
            className={styles.fileButtonLabel}
            data-testid="file-picker-btn"
          >
            <span>[File] {u.chooseFileBtn}</span>
          </button>
          <label
            htmlFor="upload-file-input"
            className={styles.visuallyHiddenFileInput}
            data-testid="file-picker-label"
          >
            {u.chooseFileBtn}
          </label>
          <input
            id="upload-file-input"
            ref={fileInputRef}
            type="file"
            accept={acceptTypes}
            tabIndex={-1}
            onChange={handleInputChange}
            disabled={inputDisabled}
            className={styles.visuallyHiddenFileInput}
            data-testid="upload-file-input"
          />
        </div>
      </div>

      {isProcessingImage && (
        <p role="status" style={{ fontWeight: 700, color: "#1e3a8a" }} data-testid="image-processing-status">
          {u.processingImage}
        </p>
      )}

      {isProcessingImage && (
        <button type="button" onClick={onClearImage} className={styles.smallBtn} data-testid="cancel-image-processing-btn">
          {uiLang === "en" ? "Cancel image processing" : "画像処理をキャンセル"}
        </button>
      )}

      {/* Interactive Image Crop Editor */}
      {effectiveBaseImage && effectiveDraftCrop && (
        <ImageCropEditor
          messages={messages}
          sourcePreviewUrl={effectiveBasePreviewUrl}
          imageWidth={effectiveBaseImage.width}
          imageHeight={effectiveBaseImage.height}
          draftCrop={effectiveDraftCrop}
          appliedCrop={effectiveAppliedCrop}
          isCropped={isCropped}
          isEditorOpen={isCropEditorOpen}
          disabled={isProcessingImage || isAnalyzing}
          isAnalyzing={isAnalyzing}
          onChangeDraftCrop={onChangeDraftCrop}
          onApplyCrop={onApplyCrop}
          onResetCrop={onResetCrop}
          onUseOriginalImage={onUseOriginalImage}
          onCancelCropEdit={onCancelCropEdit}
          onOpenCropEditor={onOpenCropEditor}
        />
      )}

      {/* Preview of Processed Image (Analyzed Target Image) */}
      {processedImage && (
        <div className={styles.previewBox} data-testid="processed-image-preview-box">
          <p className={styles.fieldLabel}>{u.selectedImageTitle}</p>
          {previewUrl && (
            <div className={styles.previewImageWrapper}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt={u.selectedImageTitle}
                className={styles.previewImage}
                data-testid="uploaded-menu-preview-img"
              />
            </div>
          )}

          {isCropped && (
            <div className={styles.cropSafetyWarning} role="note" data-testid="cropped-preview-safety-note">
              <p className={styles.cropSafetyWarningTitle}>[!] {u.cropSafetyWarningTitle}</p>
              <p className={styles.cropSafetyWarningBody}>{u.cropSafetyWarningBody}</p>
            </div>
          )}

          <p role="note" data-testid="image-quality-warning">
            {uiLang === "en"
              ? "Resizing or compression may make small allergen text difficult to read. Check the preview; if text is unclear, take a closer photo of that area and confirm with staff."
              : "リサイズ・圧縮で細かいアレルゲン表記が読みにくくなる場合があります。プレビューを確認し、不鮮明な場合は該当箇所を近くから撮影し直して店員に確認してください。"}
          </p>
          <div className={styles.metaBadgesRow}>
            <span className={styles.metaBadgeSuccess} data-testid="exif-stripped-badge">
              [✓] {u.exifStrippedBadge}
            </span>
            {processedImage.detectedOrientation !== 1 && (
              <span className={styles.metaBadgeSuccess} data-testid="orientation-normalized-badge">
                [✓] {u.orientationNormalizedBadge} (EXIF #{processedImage.detectedOrientation})
              </span>
            )}
            {isCropped && (
              <span className={styles.metaBadgeSuccess} data-testid="cropped-image-badge">
                [✓] {u.croppedBadge}
              </span>
            )}
            <span className={styles.metaBadge} data-testid="processed-dimensions-badge">
              {u.dimensionsLabel}: {processedImage.width} × {processedImage.height} px
            </span>
            <span className={styles.metaBadge}>
              {u.originalSizeLabel}: {formatByteSize(processedImage.originalBytes)}
            </span>
            <span className={styles.metaBadge} data-testid="processed-size-badge">
              {u.processedSizeLabel}: {formatByteSize(processedImage.processedBytes)} ({processedImage.mimeType})
            </span>
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={onClearImage}
              disabled={isAnalyzing}
              className={styles.smallBtn}
              data-testid="clear-image-btn"
            >
              {u.retakeOrChangeBtn}
            </button>
          </div>
        </div>
      )}

      {/* Developer Mock Scenario Selector (hidden in production) */}
      {showDevMockSelector && (
        <div className={styles.devMockPanel} data-testid="dev-mock-panel">
          <p className={styles.devMockTitle}>[DEV] {u.devMockPanelTitle}</p>
          <p className={styles.infoBoxBody}>{u.devMockPanelHelp}</p>
          <label htmlFor="dev-mock-scenario-select" className={styles.fieldLabel} style={{ marginTop: 8, marginBottom: 2 }}>
            {u.devMockScenarioLabel}
          </label>
          <select
            id="dev-mock-scenario-select"
            value={mockScenario}
            onChange={(e) => onChangeMockScenario(e.target.value as DevMockScenarioId)}
            disabled={isAnalyzing}
            className={styles.devMockSelect}
            data-testid="dev-mock-scenario-select"
          >
            {DEV_MOCK_SCENARIOS.map((sc) => (
              <option key={sc.id} value={sc.id}>
                {uiLang === "en" ? sc.labelEn : sc.labelJa}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Actions */}
      <div className={styles.actionRow}>
        {isOffline && (
          <p
            className={styles.offlineHintText}
            role="note"
            data-testid="offline-analyze-hint"
          >
            [!] {u.offlineAnalyzeDisabledHint}
          </p>
        )}
        <button
          type="button"
          onClick={onAnalyze}
          disabled={!processedImage || isProcessingImage || isAnalyzing || hasUnappliedCropChange || isOffline}
          className={styles.primaryBtn}
          data-testid="analyze-menu-btn"
          {...unavailableAnalysisProps}
        >
          {isAnalyzing ? u.analyzingBtn : u.analyzeBtn}
        </button>
        <button
          type="button"
          onClick={onGoToCardDirectly}
          disabled={isAnalyzing}
          className={styles.secondaryBtn}
          data-testid="upload-to-card-btn"
        >
          {messages.settings.goToCardDirectly}
        </button>
        <button
          type="button"
          onClick={onBackToSettings}
          disabled={isAnalyzing}
          className={styles.secondaryBtn}
          data-testid="back-to-settings-btn"
        >
          {u.backToSettingsBtn}
        </button>
      </div>
    </section>
  );
}
