"use client";

import React, { useEffect, useRef, useState } from "react";
import { ALLERGEN_CODES, type AllergenCode } from "@/contracts/allergens";
import {
  makeError,
  type AnalyzeMenuError,
  type AnalyzeMenuResponse,
  type LanguagePair,
} from "@/contracts/analyze";
import {
  submitAnalyzeMenu,
  type DevMockScenarioId,
} from "@/client/analyzeClient";
import {
  UI_MESSAGES,
  resolveUiLang,
} from "@/client/i18n";
import {
  areCropRectsEqual,
  clampCropRect,
  createFullCropRect,
  isFullCropRect,
  type PixelCropRect,
} from "@/client/imageCropGeometry";
import {
  processMenuImage,
  type ProcessedMenuImage,
} from "@/client/imageProcessor";
import {
  DEFAULT_USER_SETTINGS,
  clearUserSettings,
  loadUserSettings,
  normalizeSelectedAllergens,
  sanitizeUserSettings,
  saveUserSettings,
  type UserSettings,
} from "@/client/settingsStorage";
import { AnalysisResultSection, type ResultViewMode } from "./AnalysisResultSection";
import { ConfirmationCardPlaceholder } from "./ConfirmationCardPlaceholder";
import { DietaryConfirmationCard } from "./DietaryConfirmationCard";
import { DietarySettingsCoordinator } from "@/client/dietarySettingsCoordinator";
import { DietarySettingsSection } from "./DietarySettingsSection";
import {
  DEFAULT_DIETARY_SETTINGS,
  readDietarySettingsResult,
  type DietarySettings,
} from "@/client/dietarySettingsStorage";
import { ErrorBanner } from "./ErrorBanner";
import { ImageUploadSection } from "./ImageUploadSection";
import { SettingsSection } from "./SettingsSection";
import { registerServiceWorker, isOfflineReady } from "@/client/serviceWorkerRegistration";
import { useOnlineStatus, isBrowserOnline } from "@/client/onlineStatus";
import styles from "./AllergyBridgeApp.module.css";

export type AppStep = "settings" | "upload" | "results" | "confirmCard" | "dietaryCard";

export type AnalysisInputSnapshot = {
  readonly imageId: string;
  readonly userLang: string;
  readonly storeLang: string;
  readonly allergensKey: string;
  readonly mockScenario: DevMockScenarioId;
};

export type CommittedAnalysis = {
  readonly generation: number;
  readonly snapshot: AnalysisInputSnapshot;
  readonly response: AnalyzeMenuResponse;
};

export function createInputSnapshot(params: {
  imageId: string | null;
  settings: UserSettings;
  mockScenario: DevMockScenarioId;
}): AnalysisInputSnapshot | null {
  if (!params.imageId || params.settings.allergens.length === 0) {
    return null;
  }
  return {
    imageId: params.imageId,
    userLang: params.settings.userLang,
    storeLang: params.settings.storeLang,
    allergensKey: normalizeSelectedAllergens(params.settings.allergens).join(","),
    mockScenario: params.mockScenario,
  };
}

export function doesSnapshotMatch(
  a: AnalysisInputSnapshot | null,
  b: AnalysisInputSnapshot | null,
): boolean {
  if (!a || !b) return false;
  return (
    a.imageId === b.imageId &&
    a.userLang === b.userLang &&
    a.storeLang === b.storeLang &&
    a.allergensKey === b.allergensKey &&
    a.mockScenario === b.mockScenario
  );
}

export type AllergyBridgeAppProps = {
  /** Explicit opt-in for development Mock; the public Phase A page always passes false. */
  analysisAvailable?: boolean;
  initialStep?: AppStep;
  initialSettings?: UserSettings;
  initialProcessedImage?: ProcessedMenuImage | null;
  initialPreviewUrl?: string | null;
  initialOriginalPreviewUrl?: string | null;
  initialResponse?: AnalyzeMenuResponse | null;
  initialError?: AnalyzeMenuError | null;
  initialSelectedDishIds?: string[];
  initialViewMode?: ResultViewMode;
  initialMockScenario?: DevMockScenarioId;
  initialSpecsModalOpen?: boolean;
  initialDietarySettings?: DietarySettings;
  nodeEnv?: string;
};

export function AllergyBridgeApp({
  analysisAvailable = false,
  initialStep = "settings",
  initialSettings,
  initialProcessedImage = null,
  initialPreviewUrl = null,
  initialOriginalPreviewUrl = null,
  initialResponse = null,
  initialError = null,
  initialSelectedDishIds = [],
  initialViewMode = "dish",
  initialMockScenario = "ok",
  initialSpecsModalOpen = false,
  initialDietarySettings,
  nodeEnv,
}: AllergyBridgeAppProps) {
  const [step, setStep] = useState<AppStep>(initialStep);
  const { isOffline, showReconnectedBanner, dismissReconnectedBanner } = useOnlineStatus();
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    let current = true;
    const check = async () => {
      const ready = await isOfflineReady();
      if (current) setOfflineReady(ready);
    };
    let serviceWorkers: ServiceWorkerContainer | undefined;
    try { serviceWorkers = navigator.serviceWorker; } catch { /* Storage may be denied. */ }
    void registerServiceWorker().then(check);
    serviceWorkers?.addEventListener("controllerchange", check);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    const timer = window.setInterval(check, 15000);
    return () => {
      current = false;
      window.clearInterval(timer);
      serviceWorkers?.removeEventListener("controllerchange", check);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
    };
  }, []);
  const cardNavigationRequestedRef = useRef(false);

  useEffect(() => {
    if (step !== "confirmCard" || !cardNavigationRequestedRef.current) return;
    cardNavigationRequestedRef.current = false;
    // Only an explicit transition to the card moves focus; edits and re-renders do not.
    document.getElementById("confirm-card-section-title")?.focus({ preventScroll: true });
    // Keep the persistent safety warning visible above the card, without decorative scrolling.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [step]);
  // SSR & client initial render must match deterministically; localStorage is restored after mount in useEffect.
  const [settings, setSettings] = useState<UserSettings>(() =>
    initialSettings
      ? sanitizeUserSettings(initialSettings)
      : { ...DEFAULT_USER_SETTINGS, allergens: [] },
  );
  const [settingsReady, setSettingsReady] = useState(initialSettings !== undefined);
  const [settingsClearedBanner, setSettingsClearedBanner] = useState<boolean>(false);
  const [dietarySettings, setDietarySettings] = useState<DietarySettings>(() =>
    initialDietarySettings ? initialDietarySettings : DEFAULT_DIETARY_SETTINGS,
  );
  const dietaryCoordinatorRef = useRef<DietarySettingsCoordinator | null>(null);
  if (dietaryCoordinatorRef.current === null) dietaryCoordinatorRef.current = new DietarySettingsCoordinator(dietarySettings);
  const [dietaryPending, setDietaryPending] = useState(false);
  const dietaryPendingRef = useRef(false);
  const dietaryMountedRef = useRef(true);
  useEffect(() => {
    dietaryMountedRef.current = true;
    return () => { dietaryMountedRef.current = false; dietaryCoordinatorRef.current!.invalidate(); };
  }, []);
  const [isSpecsModalOpen, setIsSpecsModalOpen] = useState<boolean>(initialSpecsModalOpen);

  const specsTriggerBtnRef = useRef<HTMLButtonElement | null>(null);
  const specsModalDialogRef = useRef<HTMLDivElement | null>(null);
  const specsModalCloseBtnRef = useRef<HTMLButtonElement | null>(null);

  const initialImageId = initialProcessedImage || initialResponse ? "initial-img-0" : null;
  const sourceFileRef = useRef<File | Blob | null>(initialProcessedImage ? initialProcessedImage.blob : null);
  const [baseProcessedImage, setBaseProcessedImage] = useState<ProcessedMenuImage | null>(initialProcessedImage);
  const [processedImage, setProcessedImage] = useState<ProcessedMenuImage | null>(initialProcessedImage);
  const [imageId, setImageId] = useState<string | null>(initialImageId);
  const imageSeqRef = useRef<number>(1);
  const imageProcessGenRef = useRef<number>(0);

  const [basePreviewUrl, setBasePreviewUrl] = useState<string | null>(initialPreviewUrl);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialPreviewUrl);
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(initialOriginalPreviewUrl);
  const createdOriginalObjectUrlRef = useRef<string | null>(null);
  const createdBaseObjectUrlRef = useRef<string | null>(null);
  const createdCroppedObjectUrlRef = useRef<string | null>(null);

  const [draftCropRect, setDraftCropRect] = useState<PixelCropRect | null>(() =>
    initialProcessedImage ? createFullCropRect(initialProcessedImage.width, initialProcessedImage.height) : null,
  );
  const [appliedCropRect, setAppliedCropRect] = useState<PixelCropRect | null>(() =>
    initialProcessedImage ? createFullCropRect(initialProcessedImage.width, initialProcessedImage.height) : null,
  );
  const [isCropEditorOpen, setIsCropEditorOpen] = useState<boolean>(Boolean(initialProcessedImage));
  const [isProcessingImage, setIsProcessingImage] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  const navigateToStep = (nextStep: AppStep) => {
    if (dietaryPendingRef.current) return;
    cardNavigationRequestedRef.current = nextStep === "confirmCard" && step !== "confirmCard";
    if (nextStep !== "upload" && isProcessingImage) {
      imageProcessGenRef.current += 1;
      setIsProcessingImage(false);
    }
    setStep(nextStep);
  };
  const [mockScenario, setMockScenario] = useState<DevMockScenarioId>(initialMockScenario);

  const [committedAnalysis, setCommittedAnalysis] = useState<CommittedAnalysis | null>(() => {
    if (!initialResponse) return null;
    const initSettings = initialSettings
      ? sanitizeUserSettings(initialSettings)
      : { ...DEFAULT_USER_SETTINGS, allergens: [] };
    const snap = createInputSnapshot({
      imageId: initialImageId,
      settings: initSettings,
      mockScenario: initialMockScenario,
    });
    if (!snap) return null;
    return {
      generation: 0,
      snapshot: snap,
      response: initialResponse,
    };
  });

  const [apiError, setApiError] = useState<AnalyzeMenuError | null>(initialError);
  const [selectedDishIdsForCard, setSelectedDishIdsForCard] = useState<string[]>(initialSelectedDishIds);

  // Monotonic generation counter and active AbortController for invalidating in-flight requests
  const generationRef = useRef<number>(1);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const hasUserModifiedSettingsRef = useRef<boolean>(false);

  const settingsRef = useRef<UserSettings>(settings);
  const imageIdRef = useRef<string | null>(imageId);
  const mockScenarioRef = useRef<DevMockScenarioId>(mockScenario);

  const currentSnapshot = createInputSnapshot({
    imageId,
    settings,
    mockScenario,
  });
  const latestSnapshotRef = useRef<AnalysisInputSnapshot | null>(currentSnapshot);

  useEffect(() => {
    settingsRef.current = settings;
    imageIdRef.current = imageId;
    mockScenarioRef.current = mockScenario;
    latestSnapshotRef.current = currentSnapshot;
  }, [settings, imageId, mockScenario, currentSnapshot]);

  // SSR remains deterministic. Controls are disabled until this restoration
  // commits, so a displayed checkbox cannot accept an input that hydration loses.
  useEffect(() => {
    let cancelled = false;
    const dietaryGeneration = dietaryCoordinatorRef.current!.checkpoint();
    queueMicrotask(async () => {
      const restoredDietary = initialDietarySettings === undefined ? await readDietarySettingsResult() : null;
      if (cancelled) return;
      if (initialSettings === undefined && !hasUserModifiedSettingsRef.current) {
        const stored = loadUserSettings();
        settingsRef.current = stored;
        latestSnapshotRef.current = createInputSnapshot({
          imageId: imageIdRef.current, settings: stored, mockScenario: mockScenarioRef.current,
        });
        setSettings(stored);
      }
      if (restoredDietary) {
        const accepted = dietaryCoordinatorRef.current!.restore(restoredDietary, dietaryGeneration);
        if (accepted) setDietarySettings(accepted);
      }
      setSettingsReady(true);
    });
    return () => { cancelled = true; };
  }, [initialSettings, initialDietarySettings]);

  // Synchronize dietary settings across multiple browser tabs (MAJOR-2)
  useEffect(() => {
    if (typeof window === "undefined") return;
    let mounted = true;
    const handleStorage = (e: StorageEvent) => {
      if (
        e.key === "allergy_bridge_dietary_restrictions_v1" ||
        e.key === "allergy_bridge_dietary_restrictions_cleared_at_v1" ||
        e.key === "allergy_bridge_dietary_restrictions_deletion_generation_v2"
      ) {
        void readDietarySettingsResult().then(latest => {
          if (!mounted) return;
          const accepted = dietaryCoordinatorRef.current!.synchronize(latest);
          if (accepted) setDietarySettings(accepted);
        });
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => { mounted = false; window.removeEventListener("storage", handleStorage); };
  }, []);

  const revokeBaseObjectUrl = () => {
    if (createdBaseObjectUrlRef.current && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(createdBaseObjectUrlRef.current);
      createdBaseObjectUrlRef.current = null;
    }
  };

  const revokeOriginalObjectUrl = () => {
    if (createdOriginalObjectUrlRef.current && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(createdOriginalObjectUrlRef.current);
      createdOriginalObjectUrlRef.current = null;
    }
  };
  const revokeCroppedObjectUrl = () => {
    if (createdCroppedObjectUrlRef.current && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(createdCroppedObjectUrlRef.current);
      createdCroppedObjectUrlRef.current = null;
    }
  };

  const revokeProcessedObjectUrls = () => {
    revokeCroppedObjectUrl();
    revokeBaseObjectUrl();
  };

  const revokeAllObjectUrls = () => {
    revokeProcessedObjectUrls();
    revokeOriginalObjectUrl();
  };
  /**
   * Immediately invalidates any committed analysis result, dish selection, and in-flight request.
   */
  const invalidateAnalysis = (nextSnapshot: AnalysisInputSnapshot | null) => {
    generationRef.current += 1;
    latestSnapshotRef.current = nextSnapshot;
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    setIsAnalyzing(false);
    setCommittedAnalysis(null);
    setSelectedDishIdsForCard([]);
  };

  useEffect(() => {
    return () => {
      // Invalidate current image processing generation so late async tasks do not create lingering Object URLs
      imageProcessGenRef.current += 1;
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }
      revokeAllObjectUrls();
    };
  // Cleanup callbacks only access refs; they intentionally run once on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeSpecsModal = () => {
    setIsSpecsModalOpen(false);
    const triggerEl = specsTriggerBtnRef.current;
    if (triggerEl) {
      // Restore focus to the trigger button after modal closes
      setTimeout(() => {
        triggerEl.focus();
      }, 0);
    }
  };

  useEffect(() => {
    if (!isSpecsModalOpen) return;

    // Move focus inside the dialog immediately upon opening
    const focusTarget = specsModalCloseBtnRef.current ?? specsModalDialogRef.current;
    focusTarget?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSpecsModal();
        return;
      }
      if (e.key === "Tab") {
        const dialog = specsModalDialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;

        if (e.shiftKey) {
          if (!active || !dialog.contains(active) || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (!active || !dialog.contains(active) || active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSpecsModalOpen]);

  const uiLang = resolveUiLang(settings.userLang);
  const messages = UI_MESSAGES[uiLang];

  // A committed analysis is valid ONLY when its snapshot strictly matches the current input state
  const validAnalysisResponse: AnalyzeMenuResponse | null =
    committedAnalysis && doesSnapshotMatch(committedAnalysis.snapshot, currentSnapshot)
      ? committedAnalysis.response
      : null;

  const effectiveStep: AppStep =
    step === "results" && !validAnalysisResponse
      ? settings.allergens.length > 0
        ? "upload"
        : "settings"
      : step;

  const updateAndPersistSettings = (next: UserSettings) => {
    hasUserModifiedSettingsRef.current = true;
    setSettingsClearedBanner(false);
    setApiError(null);
    const saved = saveUserSettings(next);
    settingsRef.current = saved;
    const nextSnap = createInputSnapshot({
      imageId: imageIdRef.current,
      settings: saved,
      mockScenario: mockScenarioRef.current,
    });
    invalidateAnalysis(nextSnap);
    setSettings(saved);
    if (step === "results") {
      navigateToStep("settings");
    }
  };

  const handleSelectLanguagePair = (pair: LanguagePair) => {
    if (settings.userLang === pair.userLang && settings.storeLang === pair.storeLang) {
      return;
    }
    updateAndPersistSettings({
      ...settings,
      userLang: pair.userLang,
      storeLang: pair.storeLang,
    });
  };

  const handleToggleAllergen = (code: AllergenCode) => {
    const current = settingsRef.current;
    const exists = current.allergens.includes(code);
    const nextAllergens = exists
      ? current.allergens.filter((c) => c !== code)
      : normalizeSelectedAllergens([...current.allergens, code]);
    updateAndPersistSettings({
      ...current,
      allergens: nextAllergens,
    });
  };

  const handleSelectAllAllergens = () => {
    updateAndPersistSettings({
      ...settings,
      allergens: [...ALLERGEN_CODES],
    });
  };

  const handleClearAllAllergens = () => {
    updateAndPersistSettings({
      ...settings,
      allergens: [],
    });
  };

  const handleClearStoredSettings = () => {
    hasUserModifiedSettingsRef.current = true;
    setApiError(null);
    const reset = clearUserSettings();
    settingsRef.current = reset;
    invalidateAnalysis(null);
    setSettings(reset);
    setSettingsClearedBanner(true);
    navigateToStep("settings");
  };

  const clearSelectedImage = () => {
    imageProcessGenRef.current += 1;
    setIsProcessingImage(false);
    revokeAllObjectUrls();
    sourceFileRef.current = null;
    setBaseProcessedImage(null);
    setProcessedImage(null);
    setBasePreviewUrl(null);
    setPreviewUrl(null);
    setDraftCropRect(null);
    setAppliedCropRect(null);
    setIsCropEditorOpen(false);
    setImageId(null);
    imageIdRef.current = null;
    setOriginalPreviewUrl(null);
    invalidateAnalysis(null);
    if (step === "results") {
      navigateToStep("upload");
    }
  };

  const handleSelectFile = async (file: File | null) => {
    if (!analysisAvailable || !file) return;
    setApiError(null);
    // Clear any prior selected image & invalidate previous analysis immediately when Canvas processing begins
    const currentProcessGen = imageProcessGenRef.current + 1;
    imageProcessGenRef.current = currentProcessGen;
    revokeAllObjectUrls();
    sourceFileRef.current = null;
    setBaseProcessedImage(null);
    setProcessedImage(null);
    setBasePreviewUrl(null);
    setPreviewUrl(null);
    setDraftCropRect(null);
    setAppliedCropRect(null);
    setIsCropEditorOpen(false);
    setImageId(null);
    imageIdRef.current = null;
    setOriginalPreviewUrl(null);
    invalidateAnalysis(null);
    setIsProcessingImage(true);

    let nextOriginalUrl: string | null = null;
    try {
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        nextOriginalUrl = URL.createObjectURL(file);
        createdOriginalObjectUrlRef.current = nextOriginalUrl;
        setOriginalPreviewUrl(nextOriginalUrl);
      }
      const result = await processMenuImage(file);
      if (imageProcessGenRef.current !== currentProcessGen) {
        if (nextOriginalUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(nextOriginalUrl);
        }
        return;
      }
      if (!result.ok) {
        clearSelectedImage();
        setApiError(makeError("client-image-process", "INVALID_INPUT", result.reason));
      } else {
        revokeProcessedObjectUrls();
        sourceFileRef.current = file;
        const fullRect = createFullCropRect(result.value.width, result.value.height);
        const nextImgId = `img-${imageSeqRef.current++}`;
        imageIdRef.current = nextImgId;
        const nextSnap = createInputSnapshot({
          imageId: nextImgId,
          settings: settingsRef.current,
          mockScenario: mockScenarioRef.current,
        });
        latestSnapshotRef.current = nextSnap;
        setBaseProcessedImage(result.value);
        setProcessedImage(result.value);
        setDraftCropRect(fullRect);
        setAppliedCropRect(fullRect);
        setIsCropEditorOpen(true);
        setImageId(nextImgId);
        if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
          const nextUrl = URL.createObjectURL(result.value.blob);
          createdBaseObjectUrlRef.current = nextUrl;
          setBasePreviewUrl(nextUrl);
          setPreviewUrl(nextUrl);
        }
      }
    } catch {
      if (imageProcessGenRef.current === currentProcessGen) {
        clearSelectedImage();
        setApiError(makeError("client-image-process", "INVALID_INPUT", "unsupported_image_type"));
      } else if (nextOriginalUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(nextOriginalUrl);
      }
    } finally {
      if (imageProcessGenRef.current === currentProcessGen) {
        setIsProcessingImage(false);
      }
    }
  };

  const restoreOriginalBaseImage = (closeEditor: boolean) => {
    if (!baseProcessedImage) return;
    imageProcessGenRef.current += 1;
    setIsProcessingImage(false);
    setApiError(null);

    const fullRect = createFullCropRect(baseProcessedImage.width, baseProcessedImage.height);
    setDraftCropRect(fullRect);
    setAppliedCropRect(fullRect);
    if (closeEditor) {
      setIsCropEditorOpen(false);
    }

    const wasCropped = Boolean(processedImage?.cropped);
    revokeCroppedObjectUrl();
    setProcessedImage(baseProcessedImage);
    setPreviewUrl(basePreviewUrl);

    if (wasCropped || committedAnalysis !== null || isAnalyzing) {
      const nextImgId = `img-${imageSeqRef.current++}`;
      imageIdRef.current = nextImgId;
      setImageId(nextImgId);
      const nextSnap = createInputSnapshot({
        imageId: nextImgId,
        settings: settingsRef.current,
        mockScenario: mockScenarioRef.current,
      });
      invalidateAnalysis(nextSnap);
    }
  };

  const handleChangeDraftCrop = (nextRect: PixelCropRect) => {
    if (!baseProcessedImage) return;
    const clamped = clampCropRect(nextRect, baseProcessedImage.width, baseProcessedImage.height);
    setDraftCropRect((prev) => {
      if (prev && areCropRectsEqual(prev, clamped)) return prev;
      return clamped;
    });
    if (!appliedCropRect || !areCropRectsEqual(clamped, appliedCropRect)) {
      if (committedAnalysis !== null || isAnalyzing) {
        invalidateAnalysis(latestSnapshotRef.current);
      }
    }
  };

  const handleApplyCrop = async () => {
    if (!baseProcessedImage || !draftCropRect) return;
    const clamped = clampCropRect(draftCropRect, baseProcessedImage.width, baseProcessedImage.height);

    if (isFullCropRect(clamped, baseProcessedImage.width, baseProcessedImage.height)) {
      restoreOriginalBaseImage(false);
      return;
    }

    setApiError(null);
    const currentProcessGen = imageProcessGenRef.current + 1;
    imageProcessGenRef.current = currentProcessGen;
    invalidateAnalysis(null);
    setIsProcessingImage(true);

    const sourceBlob = sourceFileRef.current ?? baseProcessedImage.blob;

    try {
      const result = await processMenuImage(sourceBlob, {
        crop: {
          ...clamped,
          referenceWidth: baseProcessedImage.width,
          referenceHeight: baseProcessedImage.height,
        },
      });
      if (imageProcessGenRef.current !== currentProcessGen) {
        return;
      }
      if (!result.ok) {
        const fallbackSnap = createInputSnapshot({
          imageId: imageIdRef.current,
          settings: settingsRef.current,
          mockScenario: mockScenarioRef.current,
        });
        latestSnapshotRef.current = fallbackSnap;
        setApiError(makeError("client-image-crop", "INVALID_INPUT", result.reason));
      } else {
        revokeCroppedObjectUrl();
        const nextImgId = `img-${imageSeqRef.current++}`;
        imageIdRef.current = nextImgId;
        const nextSnap = createInputSnapshot({
          imageId: nextImgId,
          settings: settingsRef.current,
          mockScenario: mockScenarioRef.current,
        });
        latestSnapshotRef.current = nextSnap;
        setProcessedImage(result.value);
        setAppliedCropRect(clamped);
        setDraftCropRect(clamped);
        setImageId(nextImgId);
        if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
          const nextUrl = URL.createObjectURL(result.value.blob);
          createdCroppedObjectUrlRef.current = nextUrl;
          setPreviewUrl(nextUrl);
        }
      }
    } catch {
      if (imageProcessGenRef.current === currentProcessGen) {
        const fallbackSnap = createInputSnapshot({
          imageId: imageIdRef.current,
          settings: settingsRef.current,
          mockScenario: mockScenarioRef.current,
        });
        latestSnapshotRef.current = fallbackSnap;
        setApiError(makeError("client-image-crop", "INVALID_INPUT", "malformed_request"));
      }
    } finally {
      if (imageProcessGenRef.current === currentProcessGen) {
        setIsProcessingImage(false);
      }
    }
  };

  const handleResetCrop = () => {
    restoreOriginalBaseImage(false);
  };

  const handleUseOriginalImage = () => {
    restoreOriginalBaseImage(true);
  };

  const handleCancelCropEdit = () => {
    if (!baseProcessedImage) return;
    if (isProcessingImage) {
      imageProcessGenRef.current += 1;
      setIsProcessingImage(false);
      const fallbackSnap = createInputSnapshot({
        imageId: imageIdRef.current,
        settings: settingsRef.current,
        mockScenario: mockScenarioRef.current,
      });
      latestSnapshotRef.current = fallbackSnap;
    }
    const fallbackRect =
      appliedCropRect ?? createFullCropRect(baseProcessedImage.width, baseProcessedImage.height);
    setDraftCropRect(fallbackRect);
    setIsCropEditorOpen(false);
  };

  const handleOpenCropEditor = () => {
    if (!baseProcessedImage) return;
    setIsCropEditorOpen(true);
  };

  const handleChangeMockScenario = (nextScenario: DevMockScenarioId) => {
    if (nextScenario === mockScenario) return;
    setApiError(null);
    mockScenarioRef.current = nextScenario;
    const nextSnap = createInputSnapshot({
      imageId: imageIdRef.current,
      settings: settingsRef.current,
      mockScenario: nextScenario,
    });
    invalidateAnalysis(nextSnap);
    setMockScenario(nextScenario);
    if (step === "results") {
      navigateToStep("upload");
    }
  };

  const handleAnalyze = async () => {
    if (isOffline || !isBrowserOnline()) {
      invalidateAnalysis(null);
      setApiError(null);
      return;
    }
    if (!processedImage || !imageId) {
      invalidateAnalysis(null);
      setApiError(makeError("client-no-image", "INVALID_INPUT", "image_missing"));
      return;
    }

    const requestSnapshot = createInputSnapshot({
      imageId,
      settings,
      mockScenario,
    });
    if (!requestSnapshot) {
      invalidateAnalysis(null);
      setApiError(makeError("client-invalid-settings", "INVALID_INPUT", "invalid_allergens"));
      return;
    }

    // Starting a new analysis immediately invalidates any prior committed result and aborts any prior request
    setApiError(null);
    invalidateAnalysis(requestSnapshot);
    const requestGen = generationRef.current;
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    setIsAnalyzing(true);

    try {
      const res = await submitAnalyzeMenu({
        userLang: settings.userLang,
        storeLang: settings.storeLang,
        allergens: settings.allergens,
        image: processedImage.blob,
        mockScenario,
        nodeEnv,
        signal: controller.signal,
      });

      // Verify generation, AbortSignal, and snapshot match before applying response
      if (
        generationRef.current !== requestGen ||
        controller.signal.aborted ||
        !doesSnapshotMatch(requestSnapshot, latestSnapshotRef.current)
      ) {
        return;
      }

      if (!res.ok) {
        if (res.aborted) return;
        setCommittedAnalysis(null);
        setSelectedDishIdsForCard([]);
        setApiError(res.error);
        if (step === "results") {
          navigateToStep("upload");
        }
      } else {
        setCommittedAnalysis({
          generation: requestGen,
          snapshot: requestSnapshot,
          response: res.data,
        });
        setSelectedDishIdsForCard([]);
        navigateToStep("results");
      }
    } finally {
      if (generationRef.current === requestGen) {
        activeAbortControllerRef.current = null;
        setIsAnalyzing(false);
      }
    }
  };

  const handleAnalyzeWhenAvailable = async () => {
    if (!analysisAvailable) return;
    await handleAnalyze();
  };

  const handleRetakePhoto = () => {
    setApiError(null);
    clearSelectedImage();
    navigateToStep("upload");
  };

  const handleToggleDishForCard = (dishId: string) => {
    if (!validAnalysisResponse) return;
    setSelectedDishIdsForCard((prev) =>
      prev.includes(dishId) ? prev.filter((id) => id !== dishId) : [...prev, dishId],
    );
  };

  const handleProceedToConfirmCard = (specificDishId?: string) => {
    if (validAnalysisResponse && specificDishId && !selectedDishIdsForCard.includes(specificDishId)) {
      setSelectedDishIdsForCard((prev) => [...prev, specificDishId]);
    }
    navigateToStep("confirmCard");
  };

  const targetItems = validAnalysisResponse
    ? validAnalysisResponse.items.filter((item) => selectedDishIdsForCard.includes(item.id))
    : [];

  return (
    <main className={styles.container} lang={uiLang} data-testid="allergy-bridge-main" data-ui-lang={uiLang}>
      {/* Fixed Viewport Background (CSS-only pattern, scroll-independent, loops right-to-left) */}
      <div className={styles.fixedScrollingBg} aria-hidden="true" data-testid="fixed-scrolling-bg" />
      <div className={styles.fixedBgVeil} aria-hidden="true" />

      <div className={styles.contentLayer}>
        {/* App Header with Top-Right Specs ("仕様") Button */}
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <h1 className={styles.title}>{messages.appTitle}</h1>
            <button
              ref={specsTriggerBtnRef}
              type="button"
              onClick={() => setIsSpecsModalOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={isSpecsModalOpen}
              className={styles.specsTriggerBtn}
              data-testid="specs-modal-trigger"
            >
              [i] {messages.specsBtnLabel}
            </button>
          </div>
          <p className={styles.subtitle}>{messages.appSubtitle}</p>
        </header>

        {/* Specs Modal Popup (low-priority technical specifications & data handling, focus-trapped) */}
        {isSpecsModalOpen && (
          <div
            className={styles.modalOverlay}
            onClick={closeSpecsModal}
            data-testid="specs-modal-overlay"
          >
            <div
              ref={specsModalDialogRef}
              className={styles.modalDialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby="specs-modal-title"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              data-testid="specs-modal-dialog"
            >
              <div className={styles.modalHeader}>
                <h2 id="specs-modal-title" className={styles.modalTitle}>
                  {messages.specsModal.title}
                </h2>
                <button
                  ref={specsModalCloseBtnRef}
                  type="button"
                  onClick={closeSpecsModal}
                  className={styles.smallBtn}
                  data-testid="specs-modal-close-btn"
                >
                  {messages.specsModal.closeBtn}
                </button>
              </div>
              <ul className={styles.modalList} data-testid="specs-modal-list">
                {messages.specsModal.items.map((item, idx) => (
                  <li key={idx}>
                    <strong className={styles.infoBoxTitle} style={{ display: "block" }}>
                      {item.title}
                    </strong>
                    <span className={styles.infoBoxBody}>{item.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Persistent Safety Invariant Banner (Always-Visible Critical Warning) */}
        <div className={styles.safetyBanner} role="note" data-testid="persistent-safety-banner">
          <p className={styles.safetyBannerTitle}>[!] {messages.safetyBannerTitle}</p>
          <p className={styles.safetyBannerBody}>{messages.safetyBannerBody}</p>
        </div>

        <p role="status" data-testid="offline-cache-status" data-ready={offlineReady}>
          {offlineReady ? messages.offline.cacheReady : messages.offline.cacheNotReady}
        </p>

        {/* Reconnected Banner */}
        {showReconnectedBanner && !isOffline && (
          <div
            className={styles.onlineRestoredBanner}
            role="status"
            data-testid="online-restored-banner"
          >
            <span>{messages.offline.reconnectedNotice}</span>
            <button
              type="button"
              onClick={dismissReconnectedBanner}
              className={styles.smallBtn}
              data-testid="dismiss-reconnected-btn"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {/* Offline Status Banner */}
        {isOffline && (
          <div
            className={styles.offlineBanner}
            role="status"
            aria-live="polite"
            data-testid="offline-status-banner"
          >
            <div className={styles.offlineBannerHeader}>
              <span className={styles.offlineBadge} data-testid="offline-badge">
                {messages.offline.badgeLabel}
              </span>
              <strong className={styles.offlineBannerTitle}>
                {messages.offline.bannerTitle}
              </strong>
            </div>
            <p className={styles.offlineBannerBody}>
              {messages.offline.bannerBody}
            </p>
            {settings.allergens.length > 0 && effectiveStep !== "confirmCard" && (
              <div className={styles.offlineBannerAction}>
                <button
                  type="button"
                  onClick={() => navigateToStep("confirmCard")}
                  className={styles.secondaryBtn}
                  data-testid="offline-go-to-card-btn"
                >
                  {messages.offline.goToCardBtn}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step Navigation Bar */}
        <nav aria-label="Progress steps">
          <ol className={styles.stepNav}>
            <li>
              <button
                type="button"
                onClick={() => navigateToStep("settings")}
                className={`${styles.stepBtn} ${effectiveStep === "settings" ? styles.stepBtnActive : ""}`}
                data-testid="step-nav-settings"
                disabled={dietaryPending}
              >
                {messages.steps.settings}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  if (settings.allergens.length > 0) navigateToStep("upload");
                }}
                disabled={dietaryPending || settings.allergens.length === 0}
                className={`${styles.stepBtn} ${effectiveStep === "upload" ? styles.stepBtnActive : ""}`}
                data-testid="step-nav-upload"
              >
                {messages.steps.upload}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  if (validAnalysisResponse) navigateToStep("results");
                }}
                disabled={dietaryPending || !validAnalysisResponse}
                className={`${styles.stepBtn} ${effectiveStep === "results" ? styles.stepBtnActive : ""}`}
                data-testid="step-nav-results"
              >
                {messages.steps.results}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  if (settings.allergens.length > 0) navigateToStep("confirmCard");
                }}
                disabled={dietaryPending || settings.allergens.length === 0}
                className={`${styles.stepBtn} ${effectiveStep === "confirmCard" ? styles.stepBtnActive : ""}`}
                data-testid="step-nav-confirmCard"
              >
                {messages.steps.confirmCard}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  if (dietarySettings.selectedConditions.length > 0) navigateToStep("dietaryCard");
                }}
                disabled={dietaryPending || dietarySettings.selectedConditions.length === 0}
                className={`${styles.stepBtn} ${effectiveStep === "dietaryCard" ? styles.stepBtnActive : ""}`}
                data-testid="step-nav-dietaryCard"
              >
                {settings.userLang === "ja" ? "食事制約カード" : "Dietary Card"}
              </button>
            </li>
          </ol>
        </nav>

        {dietaryPending && (
          <p role="status" data-testid="dietary-pending-status">
            {settings.userLang === "ja"
              ? "食事制約設定を更新中です。完了まで画面移動をお待ちください。"
              : "Updating dietary settings. Please wait before changing screens."}
          </p>
        )}

        {/* API / Input Error Banner (shown whenever an error occurred, with Retake & Card Fallback paths) */}
        {!analysisAvailable && (
          <p role="status" data-testid="card-only-notice">{messages.cardOnlyNotice}</p>
        )}

        {apiError && (
          <ErrorBanner
            error={apiError}
            messages={messages}
            canRetrySameImage={Boolean(processedImage)}
            onRetrySameImage={handleAnalyzeWhenAvailable}
            onRetakePhoto={handleRetakePhoto}
            onProceedToCardFallback={() => {
              setApiError(null);
              navigateToStep("confirmCard");
            }}
          />
        )}

        {/* Step 1: Settings */}
        {effectiveStep === "settings" && (
          <fieldset
            disabled={!settingsReady || dietaryPending}
            aria-busy={!settingsReady || dietaryPending}
            data-testid="settings-interaction-gate"
            data-ready={settingsReady ? "true" : "false"}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
          <SettingsSection
            messages={messages}
            userLang={settings.userLang}
            storeLang={settings.storeLang}
            selectedAllergens={settings.allergens}
            settingsClearedBanner={settingsClearedBanner}
            onSelectLanguagePair={handleSelectLanguagePair}
            onToggleAllergen={handleToggleAllergen}
            onSelectAllAllergens={handleSelectAllAllergens}
            onClearAllAllergens={handleClearAllAllergens}
            onClearStoredSettings={handleClearStoredSettings}
            onProceedToUpload={() => {
              setApiError(null);
              navigateToStep("upload");
            }}
            onGoToCardDirectly={() => {
              setApiError(null);
              navigateToStep("confirmCard");
            }}
          />

          <DietarySettingsSection
            userLang={settings.userLang}
            storeLang={settings.storeLang}
            settings={dietarySettings}
            onPendingChange={pending => {
              if (!dietaryMountedRef.current) return;
              dietaryPendingRef.current = pending;
              setDietaryPending(pending);
            }}
            onBeginOperation={() => dietaryCoordinatorRef.current!.begin()}
            onInvalidateOperations={() => dietaryCoordinatorRef.current!.invalidate()}
            onUpdateSettings={async (result, generation, intent) => {
              if (!dietaryMountedRef.current) return null;
              let accepted = dietaryCoordinatorRef.current!.complete(generation, result, intent);
              if (accepted === null) {
                // Discard the old response itself. A save may still have committed
                // a later revision; read the canonical store afresh rather than
                // leaving the UI behind it or trusting the discarded payload.
                const latest = await readDietarySettingsResult();
                if (!dietaryMountedRef.current) return null;
                accepted = dietaryCoordinatorRef.current!.synchronize(latest);
              }
              if (accepted && dietaryMountedRef.current) setDietarySettings(accepted);
              return accepted;
            }}
            onProceedToDietaryCard={() => {
              setApiError(null);
              navigateToStep("dietaryCard");
            }}
          />
        </fieldset>
      )}

        {/* Step 2: Image Capture / Upload */}
        {effectiveStep === "upload" && (
          <ImageUploadSection
            uiLang={uiLang}
            messages={messages}
            isOffline={isOffline}
            processedImage={processedImage}
            previewUrl={previewUrl}
            baseImage={baseProcessedImage}
            basePreviewUrl={basePreviewUrl}
            draftCropRect={draftCropRect}
            appliedCropRect={appliedCropRect}
            isCropEditorOpen={isCropEditorOpen}
            isProcessingImage={isProcessingImage}
            isAnalyzing={isAnalyzing}
            mockScenario={mockScenario}
            nodeEnv={nodeEnv}
            analysisAvailable={analysisAvailable}
            onSelectFile={handleSelectFile}
            onChangeDraftCrop={handleChangeDraftCrop}
            onApplyCrop={handleApplyCrop}
            onResetCrop={handleResetCrop}
            onUseOriginalImage={handleUseOriginalImage}
            onCancelCropEdit={handleCancelCropEdit}
            onOpenCropEditor={handleOpenCropEditor}
            onChangeMockScenario={handleChangeMockScenario}
            onAnalyze={handleAnalyzeWhenAvailable}
            onClearImage={() => {
              setApiError(null);
              clearSelectedImage();
            }}
            onBackToSettings={() => navigateToStep("settings")}
            onGoToCardDirectly={() => {
              setApiError(null);
              navigateToStep("confirmCard");
            }}
          />
        )}

        {/* Step 3: Menu Analysis Results */}
        {effectiveStep === "results" && validAnalysisResponse && (
          <AnalysisResultSection
            response={validAnalysisResponse}
            userLang={settings.userLang}
            storeLang={settings.storeLang}
            selectedAllergens={settings.allergens}
            previewUrl={previewUrl}
            originalPreviewUrl={originalPreviewUrl}
            selectedDishIdsForCard={selectedDishIdsForCard}
            messages={messages}
            initialViewMode={initialViewMode}
            onToggleDishForCard={handleToggleDishForCard}
            onProceedToConfirmCard={handleProceedToConfirmCard}
            onRetakePhoto={handleRetakePhoto}
          />
        )}

        {/* Step 4: PR4 Confirmation Card Placeholder */}
        {effectiveStep === "confirmCard" && (
          <ConfirmationCardPlaceholder
            userLang={settings.userLang}
            storeLang={settings.storeLang}
            selectedAllergens={settings.allergens}
            targetItems={targetItems}
            dataOrigin={validAnalysisResponse?.dataOrigin ?? null}
            hasAnalysisResult={Boolean(validAnalysisResponse)}
            messages={messages}
            onBackToResults={() => {
              if (validAnalysisResponse) navigateToStep("results");
            }}
            onBackToUpload={() => navigateToStep("upload")}
            onBackToSettings={() => navigateToStep("settings")}
          />
        )}

        {/* Step 5: Dietary Restrictions Confirmation Card */}
        {effectiveStep === "dietaryCard" && (
          <DietaryConfirmationCard
            userLang={settings.userLang}
            storeLang={settings.storeLang}
            selectedConditions={dietarySettings.selectedConditions}
            onBackToSettings={() => navigateToStep("settings")}
          />
        )}
      </div>
    </main>
  );
}
