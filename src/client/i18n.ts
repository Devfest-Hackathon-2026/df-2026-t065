import type { AllergenCode } from "@/contracts/allergens";
import {
  ALLERGENS,
  ALLERGEN_CODES,
} from "@/contracts/allergens";
import type {
  AssessmentCategory,
  ErrorCode,
  ImageIssueSchema,
  InvalidInputReason,
  MentionKind,
  UnconfirmedReasonSchema,
} from "@/contracts/analyze";
import type { z } from "zod";

export type UiLang = "ja" | "en";
export type ImageIssue = z.infer<typeof ImageIssueSchema>;
export type UnconfirmedReason = z.infer<typeof UnconfirmedReasonSchema>;

export function resolveUiLang(userLang: string): UiLang {
  return userLang === "en" ? "en" : "ja";
}

export function getAllergenLabel(code: AllergenCode, lang: string): string {
  const def = ALLERGENS[code];
  return lang === "en" ? def.labels.en : def.labels.ja;
}

export function getAllergenDualLabel(code: AllergenCode, userLang: string, storeLang: string): string {
  const userLabel = getAllergenLabel(code, userLang);
  const storeLabel = getAllergenLabel(code, storeLang);
  return userLabel === storeLabel ? userLabel : `${userLabel} (${storeLabel})`;
}

export type UiMessages = {
  cardOnlyNotice: string;
  appTitle: string;
  appSubtitle: string;
  specsBtnLabel: string;
  specsModal: {
    title: string;
    closeBtn: string;
    items: readonly { title: string; body: string }[];
  };
  safetyBannerTitle: string;
  safetyBannerBody: string;
  steps: {
    settings: string;
    upload: string;
    results: string;
    confirmCard: string;
  };
  settings: {
    sectionTitle: string;
    userLangLabel: string;
    storeLangLabel: string;
    langBtnJa: string;
    langBtnEn: string;
    pairAutoNote: string;
    allergensLabel: string;
    selectedCount: (count: number) => string;
    selectAll: string;
    clearAll: string;
    fishShortNote: string;
    unsupportedAllergensTitle: string;
    unsupportedAllergensBody: string;
    storageShortNote: string;
    clearSavedSettings: string;
    settingsClearedNotice: string;
    proceedToUpload: string;
    goToCardDirectly: string;
    selectAtLeastOneAllergen: string;
  };
  upload: {
    sectionTitle: string;
    takePhotoBtn: string;
    chooseFileBtn: string;
    shortFormatHint: string;
    shootingGuideTitle: string;
    shootingGuideItems: readonly [string, string, string, string, string];
    processingImage: string;
    selectedImageTitle: string;
    originalSizeLabel: string;
    processedSizeLabel: string;
    dimensionsLabel: string;
    exifStrippedBadge: string;
    orientationNormalizedBadge: string;
    croppedBadge: string;
    retakeOrChangeBtn: string;
    cropSectionTitle: string;
    cropSectionHelp: string;
    cropSafetyWarningTitle: string;
    cropSafetyWarningBody: string;
    cropKeyboardHelp: string;
    cropSelectionSummary: (params: {
      x: number;
      y: number;
      width: number;
      height: number;
      areaPercent: number;
      isCropped: boolean;
      hasUnappliedChange: boolean;
    }) => string;
    cropBoxAriaLabel: string;
    cropHandleLabels: {
      nw: string;
      ne: string;
      sw: string;
      se: string;
    };
    applyCropBtn: string;
    resetCropBtn: string;
    useOriginalImageBtn: string;
    cancelCropEditBtn: string;
    openCropEditorBtn: string;
    usingOriginalImageNotice: string;
    unappliedCropNotice: string;
    analyzeBtn: string;
    analyzingBtn: string;
    backToSettingsBtn: string;
    devMockPanelTitle: string;
    devMockPanelHelp: string;
    devMockScenarioLabel: string;
    offlineAnalyzeDisabledHint: string;
  };
  offline: {
    bannerTitle: string;
    bannerBody: string;
    badgeLabel: string;
    aiDisabledHint: string;
    reconnectedNotice: string;
    goToCardBtn: string;
    cacheReady: string;
    cacheNotReady: string;
  };
  results: {
    sectionTitle: string;
    mockDataBannerTitle: string;
    mockDataBannerBody: string;
    statusOk: string;
    statusPartial: string;
    statusUnreadable: string;
    imageIssuesTitle: string;
    imageIssueLabels: Record<ImageIssue, string>;
    reconciliationTitle: string;
    reconciliationHelp: string;
    imageSourceLabel: string;
    originalImageLabel: string;
    processedImageLabel: string;
    originalImageUnavailable: string;
    processedImageUnavailable: string;
    zoomControlsLabel: string;
    zoomOutLabel: string;
    zoomInLabel: string;
    resetZoomLabel: string;
    zoomHelp: string;
    imageRetentionNote: string;
    aiMisreadWarning: string;
    unverifiedTranslationBadge: string;
    readabilityClear: string;
    readabilityPartial: string;
    menuNoticesTitle: string;
    menuNoticesHelp: string;
    viewModeLabel: string;
    viewByDish: string;
    viewByAllergen: string;
    noItemsMessage: string;
    categoryTitles: Record<AssessmentCategory, string>;
    categoryBadges: Record<AssessmentCategory, string>;
    categoryDescriptions: Record<AssessmentCategory, string>;
    mentionKindBadges: Record<MentionKind, string>;
    mentionKindDescriptions: Record<MentionKind, string>;
    absenceClaimWarning: string;
    excerptLabel: string;
    rationaleLabel: string;
    unconfirmedReasonLabels: Record<UnconfirmedReason, string>;
    confirmationRequiredBadge: string;
    askStaffForDishBtn: string;
    askStaffSelectedBtn: (count: number) => string;
    retakePhotoBtn: string;
  };
  errors: {
    title: string;
    retryableHint: string;
    nonRetryableHint: string;
    codeMessages: Record<ErrorCode, string>;
    invalidReasonMessages: Record<InvalidInputReason, string>;
    retryBtn: string;
    retakeBtn: string;
    cardFallbackBtn: string;
  };
  confirmCard: {
    sectionTitle: string;
    showToStaffGuide: string;
    uxWorkflowLabel: string;
    uxWorkflowSteps: readonly [string, string, string, string];
    modeToggleToPresentBtn: string;
    modeToggleToReviewBtn: string;
    presentationModeActiveBanner: string;
    presentationBlockedTitle: string;
    presentationBlockedBody: string;
    verifiedBadgeTitle: string;
    verifiedBadgeBody: string;
    phraseVerificationTag: (level: string, reviewedAt: string | null) => string;
    editedUnverifiedBadge: string;
    editedCardSummaryBanner: string;
    userMemoBoxTitle: string;
    userMemoDisclaimer: string;
    userMemoStoreLangUntranslated: string;
    userMemoUserLangUntranslated: string;
    singleLangMismatchWarningTitle: string;
    singleLangMismatchWarningBody: string;
    originalVerifiedReferenceTitle: string;
    editPhraseBtn: string;
    closeEditPhraseBtn: string;
    resetPhraseBtn: string;
    resetAllEditsBtn: string;
    editStoreLangInputLabel: (storeLang: string) => string;
    editUserLangInputLabel: (userLang: string) => string;
    editNoAutoTranslationHint: string;
    editInvalidEmptyError: string;
    editInvalidLengthError: (max: number) => string;
    standaloneModeTitle: string;
    standaloneModeBody: string;
    unsupportedPairTitle: string;
    unsupportedPairBody: string;
    noAllergensTitle: string;
    noAllergensBody: string;
    unverifiedAllergensTitle: string;
    unverifiedAllergensBody: string;
    noticeSectionTitle: string;
    allergenQuestionsTitle: string;
    crossContactQuestionsTitle: string;
    staffAnswerSectionTitle: string;
    staffAnswerSectionHelp: string;
    staffAnswerEphemeralNotice: string;
    staffAnswerSelectedCaution: string;
    clearStaffAnswerSelectionBtn: string;
    storeLangBadgeLabel: (storeLang: string) => string;
    userLangBadgeLabel: (userLang: string) => string;
    aiDishStrongWarningTitle: string;
    aiDishStrongWarningBody: string;
    pr4PlaceholderTitle: string;
    pr4PlaceholderBody: string;
    summaryTitle: string;
    languagePairSummary: string;
    selectedAllergensSummary: string;
    targetDishesSummary: string;
    noSpecificDishesSelected: string;
    alwaysConfirmChecklistTitle: string;
    alwaysConfirmChecklist: readonly string[];
    backToResultsBtn: string;
    backToUploadBtn: string;
    backToSettingsBtn: string;
  };
};

export const UI_MESSAGES: Readonly<Record<UiLang, UiMessages>> = {
  ja: {
    cardOnlyNotice: "画像解析は現在利用できません。確認カード・食事制約カードをご利用ください。",
    appTitle: "AllergyBridge",
    appSubtitle: "外国語メニューの理解・店員への確認支援ツール",
    specsBtnLabel: "仕様",
    specsModal: {
      title: "ツールの仕様・データの扱い",
      closeBtn: "閉じる",
      items: [
        {
          title: "画像の処理形式・EXIF除去",
          body: "対応形式は JPEG / PNG / WebP です。送信画像は最大4MiB。元画像は20MiB・1,600万画素・各辺8,192pxまで受け付け、大きな画像は自動圧縮される場合があります。送信前にブラウザ内の Canvas で長辺最大 2048px にリサイズ・自動回転補正を行い、GPS位置情報等の EXIF メタデータをすべて除去します。",
        },
        {
          title: "画像・個人情報の非保存",
          body: "アップロードされた画像はメモリ内でのみ処理され、サーバーやデータベースには保存されません。",
        },
        {
          title: "アレルギー設定の端末内保存（localStorage）",
          body: "選択した言語とアレルゲン設定はお使いのブラウザ（端末内 localStorage）にのみ残ります。設定画面の「保存設定を消去」からいつでもリセットできます。",
        },
        {
          title: "対応言語ペアの仕様",
          body: "現在は「日本語 ⇄ English」の2組（日本語利用者→英語店舗、英語利用者→日本語店舗）のみ対応しています。",
        },
      ],
    },
    safetyBannerTitle: "重要：このアプリは安全や飲食可否を判定しません",
    safetyBannerBody:
      "AIの読み取りには誤読や見落としの可能性があります。「記載がない」「不使用と書かれている」場合でも、調理器具や揚げ油の共有を含め、必ず店員に直接確認してください。",
    steps: {
      settings: "1. 設定",
      upload: "2. メニュー画像",
      results: "3. 解析結果",
      confirmCard: "4. 店員確認",
    },
    settings: {
      sectionTitle: "言語・アレルゲン設定",
      userLangLabel: "Language",
      storeLangLabel: "店舗で使用されている言語",
      langBtnJa: "日本語",
      langBtnEn: "English",
      pairAutoNote: "※対応ペア（日本語 ⇄ English）に自動連動します",
      allergensLabel: "確認するアレルゲン（11種）",
      selectedCount: (count) => `${count} / ${ALLERGEN_CODES.length} 選択中`,
      selectAll: "全選択",
      clearAll: "全解除",
      fishShortNote: "※魚類全般 ※魚種の判別不可",
      unsupportedAllergensTitle: "【重要】特定可能範囲と対応外アレルギーの免責事項",
      unsupportedAllergensBody:
        "判定対象は上記11種類のみです。これ以外のアレルゲン（アーモンド・カシューナッツ等の個別ナッツ類、いか・たこ・貝類、果物、肉類など）や「魚」の特定魚種は一切判別できません（入っていないとはみなせません）。該当する方は必ず店員へ直接ご確認ください。",
      storageShortNote: "※設定はこのブラウザ（端末内 localStorage）にのみ保存されます（サーバー非保存）。",
      clearSavedSettings: "保存設定を消去",
      settingsClearedNotice: "端末内の設定を消去しました。",
      proceedToUpload: "画像撮影・選択へ進む",
      goToCardDirectly: "AIを使わず店員確認へ",
      selectAtLeastOneAllergen: "アレルゲンを1つ以上選択してください。",
    },
    upload: {
      sectionTitle: "メニュー画像の撮影・選択",
      takePhotoBtn: "カメラで撮影",
      chooseFileBtn: "画像ファイルを選択",
      shortFormatHint: "JPEG / PNG / WebP。送信画像は最大4MiB。大きな画像は自動圧縮される場合があります。元画像は20MiB・1,600万画素・各辺8,192pxまで。EXIF自動除去。",
      shootingGuideTitle: "撮影・画像選択のガイド（文字を読み取りやすくするために）",
      shootingGuideItems: [
        "メニューの文字が読める距離で撮影する",
        "照明やフラッシュの光の反射・手ぶれを避ける",
        "料理名と原材料・注意書きを途中で切らない",
        "小さい文字・欄外の脚注・アレルゲン表示も確認する",
        "複数ページの場合は必要なページを1枚ずつ個別に撮影する（※1回の解析につき1枚のみ対応）",
      ],
      processingImage: "画像を最適化・EXIF除去中...",
      selectedImageTitle: "プレビュー",
      originalSizeLabel: "元サイズ",
      processedSizeLabel: "送信サイズ",
      dimensionsLabel: "解像度",
      exifStrippedBadge: "EXIF除去済",
      orientationNormalizedBadge: "向き補正済",
      croppedBadge: "トリミング適用済",
      retakeOrChangeBtn: "撮り直す / 選び直す",
      cropSectionTitle: "解析範囲の調整（画像トリミング）",
      cropSectionHelp:
        "枠のドラッグまたは四隅のハンドルで、解析したい範囲（単一の矩形）を指定できます。縦横比は自由です。トリミングせず元画像全体を使うこともできます。",
      cropSafetyWarningTitle: "【重要】トリミングに関する安全上の注意",
      cropSafetyWarningBody:
        "切り抜いた範囲の外に重要な情報（欄外の注意書き・脚注・別欄のアレルゲン一覧・揚げ油や調理器具の共有表示など）がある可能性があります。注意書きを切り落とさないよう確認し、トリミング結果やAI解析結果だけで飲食の安全性を判断せず、必ず店員に直接確認してください。",
      cropKeyboardHelp:
        "キーボード操作：Tabキーで選択枠または四隅のハンドルに移動し、矢印キー（↑↓←→）で範囲や位置を調整できます（Shift+矢印キーで大きく移動）。",
      cropSelectionSummary: ({ x, y, width, height, areaPercent, isCropped, hasUnappliedChange }) => {
        const stateLabel = hasUnappliedChange
          ? "未適用の変更あり（「トリミングを適用」または「トリミングせず元画像を使う」を押してください）"
          : isCropped
            ? "トリミング適用済み"
            : "元画像全体（トリミングなし）";
        return `選択範囲: X=${x}px, Y=${y}px, 幅${width} × 高さ${height}px（元画像の約${areaPercent}%）— 状態: ${stateLabel}`;
      },
      cropBoxAriaLabel: "トリミング選択枠（矢印キーで位置を移動、Shift+矢印キーで大きく移動）",
      cropHandleLabels: {
        nw: "左上ハンドル（ドラッグまたは矢印キーで左上の角を調整）",
        ne: "右上ハンドル（ドラッグまたは矢印キーで右上の角を調整）",
        sw: "左下ハンドル（ドラッグまたは矢印キーで左下の角を調整）",
        se: "右下ハンドル（ドラッグまたは矢印キーで右下の角を調整）",
      },
      applyCropBtn: "トリミングを適用",
      resetCropBtn: "範囲をリセット",
      useOriginalImageBtn: "トリミングせず元画像を使う",
      cancelCropEditBtn: "編集をキャンセル",
      openCropEditorBtn: "トリミング範囲を調整する",
      usingOriginalImageNotice: "現在、トリミングせず元画像全体（向き補正・EXIF除去済）を解析対象としています。",
      unappliedCropNotice:
        "※トリミング範囲を変更中です。「トリミングを適用」または「トリミングせず元画像を使う」を押して解析対象画像を確定してください。",
      analyzeBtn: "メニューを解析する",
      analyzingBtn: "AI解析中...",
      backToSettingsBtn: "設定へ戻る",
      devMockPanelTitle: "開発用 Mock シナリオ（本番無効）",
      devMockPanelHelp: "MOCK_GEMINI=true 時に x-mock-scenario を切り替えます。",
      devMockScenarioLabel: "シナリオ",
      offlineAnalyzeDisabledHint: "オフラインのためAI解析は実行できません。検証済みの店員確認カードをご利用ください。",
    },
    offline: {
      bannerTitle: "オフラインで利用中",
      bannerBody: "通信が接続されていません。検証済みの店員確認カードはオフラインでも利用できます。AIメニュー画像解析にはインターネット通信が必要です。",
      badgeLabel: "オフライン",
      aiDisabledHint: "オフライン中はAI画像解析を実行できません",
      reconnectedNotice: "通信が復旧しました。オンライン機能が利用可能です。",
      goToCardBtn: "店員確認カードを表示",
      cacheReady: "この版のオフライン起動に必要なデータを端末内で確認しました。",
      cacheNotReady: "オフラインでの再読み込みの準備は未確認です。読み込み済みのカードはこの画面で利用できます。",
    },
    results: {
      sectionTitle: "解析結果（全項目・店員への確認必須）",
      mockDataBannerTitle: "【開発用合成データ（mock_fixture）】",
      mockDataBannerBody:
        "これは開発用の合成データ（dataOrigin: mock_fixture）であり、実際のGemini解析結果や実在店舗の情報ではありません。",
      statusOk: "読み取り完了（※未確認項目も含め必ず店員に確認してください）",
      statusPartial: "一部のみ読み取り（※文字が見切れている・不鮮明な箇所があります）",
      statusUnreadable: "読み取り不可（※写真を撮り直すか、直接店員に確認してください）",
      imageIssuesTitle: "画像の注意点",
      imageIssueLabels: {
        blurry: "画像がぼやけています（blurry）",
        cropped: "文字が見切れています（cropped）",
        low_light: "照明が暗く不鮮明です（low_light）",
        not_a_menu: "メニューとして認識できません（not_a_menu）",
      },
      reconciliationTitle: "画像照合（AI結果と見比べる）",
      reconciliationHelp: "AIの読み取りには誤読の可能性があります。OCR座標がないため、画像上のハイライトは表示しません。",
      imageSourceLabel: "表示する画像",
      originalImageLabel: "送信前の元画像",
      processedImageLabel: "AI送信画像（処理後）",
      originalImageUnavailable: "元画像はこの画面に保持されていません。再撮影・再選択してください。",
      processedImageUnavailable: "送信画像を表示できません。",
      zoomControlsLabel: "画像の拡大縮小",
      zoomOutLabel: "縮小",
      zoomInLabel: "拡大",
      resetZoomLabel: "表示をリセット",
      zoomHelp: "画像表示領域。拡大後はドラッグまたは矢印キーで移動、ホイールやピンチでも拡大縮小できます。",
      imageRetentionNote: "元画像はサーバーに送信せず端末内でのみ保持されます。AI解析に送信された処理済み画像もサーバー側で保存されず、メモリ内でのみ処理されます。画像はアプリ内の画面移動中も保持され、画像を変更・消去したときやブラウザのタブを閉じたときに端末内から解放されます。",
      aiMisreadWarning: "AI読み取り原文（誤読の可能性あり・未検証）",
      unverifiedTranslationBadge: "AI参考訳（未検証）",
      readabilityClear: "明瞭",
      readabilityPartial: "一部不鮮明（要注意）",
      menuNoticesTitle: "メニュー全体の注意書き（全料理に共通）",
      menuNoticesHelp: "揚げ油や調理器具の共有など、メニュー全体に関わる記載候補です。",
      viewModeLabel: "表示切替",
      viewByDish: "料理別",
      viewByAllergen: "アレルゲン別",
      noItemsMessage: "料理項目を読み取れませんでした。撮り直すか、下のボタンから店員確認へ進んでください。",
      categoryTitles: {
        menu_mentions: "① メニュー記載候補（AI読み取り・誤読の可能性あり）",
        ai_inferred: "② AI推測（一般知識からの推測・実原材料は未確認）",
        unconfirmed: "③ 未確認（※記載なしは「不使用」を意味しません）",
      },
      categoryBadges: {
        menu_mentions: "記載候補 (AI読取)",
        ai_inferred: "AI推測 (要確認)",
        unconfirmed: "未確認 (要確認)",
      },
      categoryDescriptions: {
        menu_mentions: "メニュー文字のAI読み取り候補です。誤読の可能性があるため元画像と店員に確認してください。",
        ai_inferred: "料理名等からの推測です。この店舗の実際の原材料を確認したものではありません。",
        unconfirmed: "記載が見当たらない・判読不能な項目です。記載がないことは非含有の根拠になりません。",
      },
      mentionKindBadges: {
        contains_claim: "含有の記載候補",
        absence_claim: "不使用の記載候補（※安全保証ではありません）",
        possible_presence: "混入・共有の可能性記載",
        ambiguous: "意味が曖昧な記載",
      },
      mentionKindDescriptions: {
        contains_claim: "このアレルゲンを含む旨の表現が読み取られました。",
        absence_claim: "「不使用（-free / no ...）」等の表現が読み取られました。",
        possible_presence: "同一施設・揚げ油の共有や混入の可能性に関する表現が読み取られました。",
        ambiguous: "関連語句が読み取られましたが意味が曖昧です。",
      },
      absenceClaimWarning:
        "【重大警告】「不使用」と記載されていても、調理器具・揚げ油の共有やだし・調味料への含有、AIの誤読の可能性があります。この記載は飲食可能・安全の保証ではありません。必ず店員に確認してください。",
      excerptLabel: "AI抜粋",
      rationaleLabel: "推測理由",
      unconfirmedReasonLabels: {
        not_mentioned: "メニューに記載なし（※記載がないことは不使用を意味しません）",
        unreadable: "不鮮明のため判読不能",
        not_assessed: "未評価のため未確認として補完",
      },
      confirmationRequiredBadge: "店員への確認必須",
      askStaffForDishBtn: "この料理を店員に確認する",
      askStaffSelectedBtn: (count) =>
        count > 0 ? `選択した料理（${count}件）を店員に確認する` : "店員に確認する（確認カード画面へ）",
      retakePhotoBtn: "写真を撮り直す",
    },
    errors: {
      title: "解析を完了できませんでした",
      retryableHint: "再試行するか、写真を撮り直してください。AIを使わずに店員確認カードを単独で使うこともできます。",
      nonRetryableHint: "写真を撮り直すか、AIを使わずに店員確認カードを単独でご利用ください。",
      codeMessages: {
        INVALID_INPUT: "画像または設定が入力条件を満たしていません（INVALID_INPUT）。",
        RATE_LIMITED: "アクセス集中または利用上限に到達しました（RATE_LIMITED）。しばらく待って再試行するか、確認カードを単独でご利用ください。",
        AI_DISABLED: "現在AI解析機能は停止中です（AI_DISABLED）。AIなしで店員確認カードをそのままご利用いただけます。",
        AI_TIMEOUT: "AI解析がタイムアウトしました（AI_TIMEOUT）。再試行するか、確認カードを単独でご利用ください。",
        AI_FAILED: "AI出力の検証または処理に失敗しました（AI_FAILED）。安全のため表示を中断しました。撮り直すか確認カードを単独でご利用ください。",
      },
      invalidReasonMessages: {
        malformed_request: "リクエスト形式が不正です（malformed_request）。画面を再読み込みするか設定を確認してください。",
        image_missing: "画像が選択されていないかデータが空です（image_missing）。メニュー写真を撮影または選択してください。",
        image_too_large: "元画像の上限（20MiB・1,600万画素・各辺8,192px）、または送信画像の上限（4MiB）を超えています。画像を小さくして再選択してください（image_too_large）。",
        unsupported_image_type: "未対応の画像形式です（unsupported_image_type）。JPEG / PNG / WebP 形式の画像を選択してください。",
        unsupported_language_pair: "未対応の言語ペアです（unsupported_language_pair）。設定画面で「日本語 ⇄ English」を選択してください。",
        invalid_allergens: "アレルゲンが選択されていません（invalid_allergens）。設定画面で1つ以上のアレルゲンを選択してください。",
      },
      retryBtn: "同じ画像で再試行する",
      retakeBtn: "撮り直す／画像を選び直す",
      cardFallbackBtn: "確認カードを単独で使う（AIなしで店員に確認）",
    },
    confirmCard: {
      sectionTitle: "店員向け確認カード",
      showToStaffGuide:
        "この画面を店員に見せ、指差しで確認してください。各枠の上段（大きな文字）に店舗の言語、下段（小さな文字）にあなたの言語を表示しています。",
      uxWorkflowLabel: "確認カードの利用フロー",
      uxWorkflowSteps: [
        "① 自動生成（検証済み定型文）",
        "② 日英併記で内容確認",
        "③ 必要なら手修正（メモリ内のみ）",
        "④ 店員に提示・指差し確認",
      ],
      modeToggleToPresentBtn: "店員に提示する表示へ切替",
      modeToggleToReviewBtn: "確認・手修正モードへ戻す",
      presentationModeActiveBanner:
        "【店員提示モード表示中】編集入力欄を閉じ、店員へ見せる表示にしています。必須の安全注意とアレルゲン表示は常時固定されます。",
      presentationBlockedTitle: "【店員への提示不可】必須の安全注意または確認項目を表示できません",
      presentationBlockedBody:
        "アレルゲン未選択・未対応言語ペア・未検証アレルゲン、または手修正の入力エラー（空欄・文字数超過等）があるため、店員への提示モードを有効化できません。設定または編集内容を確認してください。",
      verifiedBadgeTitle: "【チーム内検証済み文言（team_reviewed）】",
      verifiedBadgeBody:
        "逆翻訳および公的アレルゲン用語照合による検証記録（VerificationRecord）がある定型文のみを初期生成しています。機械翻訳や未検証（draft）の文言は一切表示しません。",
      phraseVerificationTag: (level, reviewedAt) =>
        `検証済: ${level === "external_reviewed" ? "外部ネイティブ確認済" : "チーム内検証済 (逆翻訳確認)"}${reviewedAt ? ` (${reviewedAt})` : ""}`,
      editedUnverifiedBadge: "追加メモ（手修正・未検証 / unverified）",
      editedCardSummaryBanner:
        "【追加メモあり（手修正・未検証）】一部の質問カードに利用者による追加メモが入力されています。追加メモは未検証（unverified）であり、自動翻訳や内容の自動検証は行われません。店員向けの検証済み必須質問は削除・置換されず常時ロック表示されます。",
      userMemoBoxTitle: "利用者による追加メモ（手修正・未検証 / アプリの判定ではありません）",
      userMemoDisclaimer:
        "※この枠は利用者が自由記述した未検証の補足メモです。安全や非含有の判定・保証ではなく、自動翻訳や内容の自動検証も行われません。上段のロックされた検証済み必須質問は削除・置換されません。",
      userMemoStoreLangUntranslated:
        "※店舗言語側の追加メモは未編集です（片言語を編集しても自動翻訳はされません）。",
      userMemoUserLangUntranslated:
        "※利用者言語側の追加メモは未編集です（片言語を編集しても自動翻訳はされません）。",
      singleLangMismatchWarningTitle: "【訳文不一致の注意】片方の言語のみが編集されています",
      singleLangMismatchWarningBody:
        "片方の言語を変更しても、もう一方の言語は自動翻訳・自動更新されません。日英の文面が異なる状態のため、店員への提示前に両言語の内容を必ず確認してください。",
      originalVerifiedReferenceTitle: "元の検証済み定型文（team_reviewed・保持）",
      editPhraseBtn: "手修正する",
      closeEditPhraseBtn: "編集欄を閉じる",
      resetPhraseBtn: "元に戻す（初期文言へ復元）",
      resetAllEditsBtn: "すべての手修正を元に戻す",
      editStoreLangInputLabel: (storeLang) =>
        `店舗言語の文面を編集 (${storeLang === "en" ? "English" : storeLang === "ja" ? "日本語" : storeLang})`,
      editUserLangInputLabel: (userLang) =>
        `利用者言語の文面を編集 (${userLang === "ja" ? "日本語" : userLang === "en" ? "English" : userLang})`,
      editNoAutoTranslationHint:
        "※編集内容はメモリ内でのみ保持され、元の定型文データや端末・サーバーには保存されません。自動翻訳は行われません。アレルゲン名・交差接触・店員確認必須の注意は削除できません。",
      editInvalidEmptyError:
        "【入力エラー】空欄または空白・不可視文字のみにはできません。元の文言に戻すか文字を入力してください。",
      editInvalidLengthError: (max) =>
        `【入力エラー】文字数が上限（${max}文字）を超えています。短く修正してください。`,
      standaloneModeTitle: "【カード単独利用モード（AIなし）】",
      standaloneModeBody:
        "AI解析結果を使わず、選択した言語ペアとアレルゲン設定から検証済み確認カードを表示しています。",
      unsupportedPairTitle: "【未対応の言語ペア】",
      unsupportedPairBody:
        "選択された言語ペアには検証済みの確認カード文言が存在しないため表示できません。設定画面で対応言語ペア（日本語 ⇄ English）を選択してください。",
      noAllergensTitle: "【アレルゲンが未選択です】",
      noAllergensBody:
        "現在アレルゲンが選択されていません。設定画面で1つ以上選択すると、アレルゲン別の質問カードが表示されます。",
      unverifiedAllergensTitle: "【未検証アレルゲンの警告】",
      unverifiedAllergensBody:
        "一部の選択アレルゲンに対応する検証済み文言が見つかりません。安全のため未検証の文言は表示しません。",
      noticeSectionTitle: "1. 冒頭の伝達（店員に最初に見せてください）",
      allergenQuestionsTitle: "2. アレルゲン別の含有確認（だし・エキス・派生食材を含む）",
      crossContactQuestionsTitle: "3. だし・調味料・調理器具・揚げ油の共有確認（交差接触）",
      staffAnswerSectionTitle: "4. 店員の指差し回答欄（4択・画面をタップしてハイライト可能）",
      staffAnswerSectionHelp:
        "店員に該当する回答を指差してもらうか、タップして一時的にハイライトできます。",
      staffAnswerEphemeralNotice:
        "※この指差しハイライトはその場での会話補助専用であり、端末（localStorage）やサーバーには一切記録・保存されません。どの回答が選ばれた場合でも、本アプリが飲食の安全を保証・記録することはありません。",
      staffAnswerSelectedCaution:
        "【確認時の注意】「入っていません」が指差された場合でも、調理場での混入や聞き違いがないか、上記の交差接触・揚げ油・だしの項目もあわせて確認し、最終的な判断はご自身で行ってください。",
      clearStaffAnswerSelectionBtn: "ハイライトをクリア",
      storeLangBadgeLabel: (storeLang) =>
        `店舗言語 (${storeLang === "en" ? "English" : storeLang === "ja" ? "日本語" : storeLang}) — 店員に提示`,
      userLangBadgeLabel: (userLang) =>
        `利用者言語 (${userLang === "ja" ? "日本語" : userLang === "en" ? "English" : userLang}) — 内容確認用`,
      aiDishStrongWarningTitle: "【警告】以下の料理名・判定はAIによる推測であり未確認（readBy: ai）です",
      aiDishStrongWarningBody:
        "AIの読み取り結果には誤読・見落としの可能性があります（安全の保証ではありません）。必ず実物のメニューと照らし合わせ、店員に直接確認してください。",
      pr4PlaceholderTitle: "【検証済み確認カード（PR4）】",
      pr4PlaceholderBody:
        "安全規約に基づき、機械翻訳や未検証の文言（draft）は表示せず、検証記録（VerificationRecord）付きの店舗言語カードと指差し回答UIを表示しています。",
      summaryTitle: "現在の確認条件・対象料理",
      languagePairSummary: "言語設定",
      selectedAllergensSummary: "確認対象アレルゲン（すべて店員確認必須）",
      targetDishesSummary: "確認する料理（AI読み取り結果からの引き継ぎ）",
      noSpecificDishesSelected: "料理指定なし（選択アレルゲン全体の確認）",
      alwaysConfirmChecklistTitle: "店員への必須確認ポイント",
      alwaysConfirmChecklist: [
        "原材料として含まれているか（記載なし・不使用記載の料理を含む）",
        "だし・ソース・ドレッシング・調味料に含まれていないか",
        "揚げ油（フライヤー）・鍋・まな板・調理器具を共有していないか（交差接触）",
      ],
      backToResultsBtn: "解析結果へ戻る",
      backToUploadBtn: "画像選択へ戻る",
      backToSettingsBtn: "設定へ戻る",
    },
  },
  en: {
    cardOnlyNotice: "Image analysis is currently unavailable. You can use the confirmation and dietary cards.",
    appTitle: "AllergyBridge",
    appSubtitle: "Foreign Menu Comprehension & Staff Confirmation Tool",
    specsBtnLabel: "仕様 / Specs",
    specsModal: {
      title: "Tool Specifications & Data Handling",
      closeBtn: "Close",
      items: [
        {
          title: "Image Processing & EXIF Removal",
          body: "Supports JPEG / PNG / WebP. Uploads are limited to 4 MiB; larger images may be compressed automatically. Source limits: 20 MiB, 16 million pixels, 8192px per edge. Before upload, images are resized via browser Canvas (max 2048px edge), orientation-corrected, and stripped of all EXIF metadata (such as GPS).",
        },
        {
          title: "No Server Storage of Images or Personal Data",
          body: "Uploaded images are processed in memory only and are never saved to a server or database.",
        },
        {
          title: "Device-Only Settings Storage (localStorage)",
          body: "Selected languages and allergens are stored only in this browser (localStorage) on your device. You can clear them anytime.",
        },
        {
          title: "Supported Language Pairs",
          body: "Currently supports two pairs: Japanese user → English store (ja → en) and English user → Japanese store (en → ja).",
        },
      ],
    },
    safetyBannerTitle: "Important: This app does NOT judge whether food is safe to eat",
    safetyBannerBody:
      "AI reading may contain misreadings or omissions. Even if an allergen is not listed or is marked '-free', always confirm directly with restaurant staff, including shared utensils and frying oil.",
    steps: {
      settings: "1. Settings",
      upload: "2. Menu Photo",
      results: "3. Results",
      confirmCard: "4. Ask Staff",
    },
    settings: {
      sectionTitle: "Language & Allergen Settings",
      userLangLabel: "Language",
      storeLangLabel: "店舗で使用されている言語 (Restaurant Language)",
      langBtnJa: "日本語",
      langBtnEn: "English",
      pairAutoNote: "* Automatically paired between 日本語 ⇄ English",
      allergensLabel: "Allergens to Check (11 items)",
      selectedCount: (count) => `${count} / ${ALLERGEN_CODES.length} selected`,
      selectAll: "Select all",
      clearAll: "Clear all",
      fishShortNote: "※魚類全般 ※魚種の判別不可 (All fish / no species check)",
      unsupportedAllergensTitle: "[CRITICAL] Assessment Scope & Unsupported Allergens Disclaimer",
      unsupportedAllergensBody:
        "Only the 11 allergens above can be assessed. Any other allergens (such as almonds, cashews, mollusks/shellfish other than shrimp/crab, fruits, meats) and specific fish species CANNOT be determined (and are never assumed absent). Always ask restaurant staff directly.",
      storageShortNote: "* Settings are saved only in this browser (localStorage) on your device.",
      clearSavedSettings: "Clear saved settings",
      settingsClearedNotice: "Saved settings on this device have been cleared.",
      proceedToUpload: "Continue to Menu Photo Upload",
      goToCardDirectly: "Skip AI & Ask Staff Directly",
      selectAtLeastOneAllergen: "Please select at least one allergen.",
    },
    upload: {
      sectionTitle: "Take or Upload Menu Photo",
      takePhotoBtn: "Take Photo",
      chooseFileBtn: "Choose Image File",
      shortFormatHint: "JPEG / PNG / WebP. Uploads: max 4 MiB. Larger images may be compressed automatically. Source limits: 20 MiB, 16 million pixels, 8192px per edge. EXIF auto-stripped.",
      shootingGuideTitle: "Photo & Upload Guide (To Help Keep Menu Text Readable)",
      shootingGuideItems: [
        "Take the photo close enough so menu text is clearly readable",
        "Avoid light glare, reflections, and camera shake",
        "Keep dish names, ingredients, and allergy notes uncut within the frame",
        "Check small print, footnotes, and allergen symbols",
        "For multi-page menus, photograph and analyze one relevant page at a time (* 1 image per analysis)",
      ],
      processingImage: "Optimizing image & stripping EXIF...",
      selectedImageTitle: "Preview",
      originalSizeLabel: "Original",
      processedSizeLabel: "Payload",
      dimensionsLabel: "Dimensions",
      exifStrippedBadge: "EXIF Stripped",
      orientationNormalizedBadge: "Orientation Fixed",
      croppedBadge: "Cropped",
      retakeOrChangeBtn: "Retake / Change",
      cropSectionTitle: "Adjust Analysis Area (Image Cropping)",
      cropSectionHelp:
        "Drag the selection frame or its four corner handles to select a single rectangular menu area (free aspect ratio), or use the full original image without cropping.",
      cropSafetyWarningTitle: "[IMPORTANT] Safety Notice Regarding Image Cropping",
      cropSafetyWarningBody:
        "Important information (such as allergy notes, footnotes, separate allergen charts, or shared fryer/utensil warnings) may exist outside the cropped area. Be careful not to cut off warnings, never judge food safety from cropped or AI results alone, and always confirm directly with restaurant staff.",
      cropKeyboardHelp:
        "Keyboard controls: Press Tab to focus the selection box or any of the four corner handles, then use the Arrow keys (↑↓←→) to move or resize (hold Shift + Arrow for larger steps).",
      cropSelectionSummary: ({ x, y, width, height, areaPercent, isCropped, hasUnappliedChange }) => {
        const stateLabel = hasUnappliedChange
          ? "Unapplied changes (Click 'Apply Crop' or 'Use Original Image Without Cropping')"
          : isCropped
            ? "Cropped image active"
            : "Full image active (uncropped)";
        return `Selected area: X=${x}px, Y=${y}px, ${width} × ${height}px (~${areaPercent}% of image) — Status: ${stateLabel}`;
      },
      cropBoxAriaLabel: "Crop selection frame (Use arrow keys to move position, Shift+Arrow for larger steps)",
      cropHandleLabels: {
        nw: "Top-left crop handle (Drag or use arrow keys to adjust top-left corner)",
        ne: "Top-right crop handle (Drag or use arrow keys to adjust top-right corner)",
        sw: "Bottom-left crop handle (Drag or use arrow keys to adjust bottom-left corner)",
        se: "Bottom-right crop handle (Drag or use arrow keys to adjust bottom-right corner)",
      },
      applyCropBtn: "Apply Crop",
      resetCropBtn: "Reset Range",
      useOriginalImageBtn: "Use Original Image Without Cropping",
      cancelCropEditBtn: "Cancel Edit",
      openCropEditorBtn: "Adjust Crop Area",
      usingOriginalImageNotice: "Currently using the full normalized image (without cropping) for analysis.",
      unappliedCropNotice:
        "* Crop range has been changed. Please click 'Apply Crop' or 'Use Original Image Without Cropping' to confirm the image for analysis.",
      analyzeBtn: "Analyze Menu",
      analyzingBtn: "Analyzing...",
      backToSettingsBtn: "Back to Settings",
      devMockPanelTitle: "Dev Mock Scenario (Disabled in Production)",
      devMockPanelHelp: "Switches x-mock-scenario when MOCK_GEMINI=true.",
      devMockScenarioLabel: "Scenario",
      offlineAnalyzeDisabledHint: "AI analysis is unavailable while offline. Please use the verified staff confirmation cards.",
    },
    offline: {
      bannerTitle: "Working Offline",
      bannerBody: "No internet connection detected. Verified staff confirmation cards remain fully available offline. AI menu analysis requires an internet connection.",
      badgeLabel: "Offline",
      aiDisabledHint: "AI analysis is not available while offline",
      reconnectedNotice: "Internet connection restored. Online features are available.",
      goToCardBtn: "View Confirmation Card",
      cacheReady: "The data needed to open this version offline has been checked on this device.",
      cacheNotReady: "Offline reload readiness is unconfirmed. Already loaded cards remain available on this screen.",
    },
    results: {
      sectionTitle: "Analysis Results (Staff Confirmation Required for All Items)",
      mockDataBannerTitle: "[SYNTHETIC MOCK DATA (mock_fixture)]",
      mockDataBannerBody:
        "This response is synthetic test data (dataOrigin: mock_fixture), NOT a real Gemini analysis or real restaurant information.",
      statusOk: "Analysis complete (* Always confirm with staff, including unconfirmed items)",
      statusPartial: "Partially readable (* Parts of the menu were unclear or cut off)",
      statusUnreadable: "Could not read menu (* Please retake photo or ask staff directly)",
      imageIssuesTitle: "Image Notes",
      imageIssueLabels: {
        blurry: "Image is blurry (blurry)",
        cropped: "Text is cut off (cropped)",
        low_light: "Lighting is dark (low_light)",
        not_a_menu: "Not recognized as a menu (not_a_menu)",
      },
      reconciliationTitle: "Compare images (review the AI result)",
      reconciliationHelp: "AI readings may contain misreadings. OCR coordinates are unavailable, so no image highlight is shown.",
      imageSourceLabel: "Image to display",
      originalImageLabel: "Original image before processing",
      processedImageLabel: "Image sent to AI (processed)",
      originalImageUnavailable: "The original image is not held on this screen. Retake or select it again.",
      processedImageUnavailable: "The submitted image cannot be displayed.",
      zoomControlsLabel: "Image zoom controls",
      zoomOutLabel: "Zoom out",
      zoomInLabel: "Zoom in",
      resetZoomLabel: "Reset view",
      zoomHelp: "Image display area. Drag or use arrow keys to pan when zoomed; use mouse wheel, pinch, or buttons to zoom.",
      imageRetentionNote: "Original images are kept only on this device and never sent to the server. Processed images sent for AI analysis are processed only in memory and not stored on the server. Images remain available while navigating within the app, and are released when changed, cleared, or when closing the browser tab.",
      aiMisreadWarning: "AI-Read Text (May be misread / Unverified)",
      unverifiedTranslationBadge: "Unverified AI Translation",
      readabilityClear: "Clear",
      readabilityPartial: "Partially readable (Caution)",
      menuNoticesTitle: "Menu-Wide Notices (Apply to All Dishes)",
      menuNoticesHelp: "Statements applying across dishes, such as shared fryers.",
      viewModeLabel: "View Mode",
      viewByDish: "By Dish",
      viewByAllergen: "By Allergen",
      noItemsMessage: "No menu dishes could be read. Please retake the photo or ask staff directly below.",
      categoryTitles: {
        menu_mentions: "1. Menu Mention Candidates (AI Read — May Be Misread)",
        ai_inferred: "2. AI Inferred (General Knowledge — Actual Ingredients Unverified)",
        ai_inferred_short: "2. AI Inferred",
        unconfirmed: "3. Unconfirmed (* No mention NEVER means absent)",
      } as Record<AssessmentCategory, string>,
      categoryBadges: {
        menu_mentions: "Menu Mention (AI Read)",
        ai_inferred: "AI Inferred (Confirm)",
        unconfirmed: "Unconfirmed (Confirm)",
      },
      categoryDescriptions: {
        menu_mentions: "Candidate text read by AI. May be misread; verify against photo and with staff.",
        ai_inferred: "Inferred from dish names/common recipes. Actual restaurant ingredients are not verified.",
        unconfirmed: "Not mentioned or unreadable. Absence of mention on a menu NEVER means absent.",
      },
      mentionKindBadges: {
        contains_claim: "Contains Mention",
        absence_claim: "Absence Claim (* NOT a safety guarantee)",
        possible_presence: "Possible Presence / Shared Facility",
        ambiguous: "Ambiguous Mention",
      },
      mentionKindDescriptions: {
        contains_claim: "Menu text appears to mention containing this allergen.",
        absence_claim: "Menu text appears to state '-free' or 'no ... added'.",
        possible_presence: "Menu text mentions possible cross-contact or shared fryer/facility.",
        ambiguous: "Related terms found, but meaning is unclear.",
      },
      absenceClaimWarning:
        "CRITICAL WARNING: Even if the menu states '-free' or 'not used', cross-contact via shared utensils/fryers, hidden seasonings/broth, or AI misreading is still possible. A printed absence claim is NOT a guarantee of safety. Always confirm with staff.",
      excerptLabel: "AI Excerpt",
      rationaleLabel: "Rationale",
      unconfirmedReasonLabels: {
        not_mentioned: "Not mentioned on menu (* Absence of mention does NOT mean absent)",
        unreadable: "Section unreadable",
        not_assessed: "Filled in as unconfirmed (not assessed)",
      },
      confirmationRequiredBadge: "Staff Confirmation Required",
      askStaffForDishBtn: "Ask Staff About This Dish",
      askStaffSelectedBtn: (count) =>
        count > 0 ? `Ask Staff About Selected Dishes (${count})` : "Ask Restaurant Staff (Confirmation Card)",
      retakePhotoBtn: "Retake Photo",
    },
    errors: {
      title: "Could Not Complete Menu Analysis",
      retryableHint: "Please retry, retake the photo, or use the Staff Confirmation Card directly without AI.",
      nonRetryableHint: "Please retake the photo or use the Staff Confirmation Card directly without AI.",
      codeMessages: {
        INVALID_INPUT: "The image or settings did not meet input requirements (INVALID_INPUT).",
        RATE_LIMITED: "Rate limit or quota reached (RATE_LIMITED). Please wait and retry, or use the confirmation card without AI.",
        AI_DISABLED: "AI analysis is currently disabled (AI_DISABLED). You can still use the Staff Confirmation Card without AI.",
        AI_TIMEOUT: "AI analysis timed out (AI_TIMEOUT). Please retry or use the Staff Confirmation Card without AI.",
        AI_FAILED: "AI output validation or processing failed (AI_FAILED). Display halted safely; please retake the photo or use the confirmation card without AI.",
      },
      invalidReasonMessages: {
        malformed_request: "Invalid request format (malformed_request). Please reload or check your settings.",
        image_missing: "No image file provided or file is empty (image_missing). Please take or select a menu photo.",
        image_too_large: "Image exceeds the source limits (20 MiB, 16 million pixels, 8192px per edge) or the 4 MiB upload limit. Choose a smaller image (image_too_large).",
        unsupported_image_type: "Unsupported image format (unsupported_image_type). Please select a JPEG, PNG, or WebP image.",
        unsupported_language_pair: "Unsupported language pair (unsupported_language_pair). Please select Japanese ⇄ English in Settings.",
        invalid_allergens: "No allergens selected (invalid_allergens). Please select at least one allergen in Settings.",
      },
      retryBtn: "Retry With Same Image",
      retakeBtn: "Retake / Choose Another Photo",
      cardFallbackBtn: "Use Confirmation Card Only (Ask Staff Without AI)",
    },
    confirmCard: {
      sectionTitle: "Staff Confirmation Card",
      showToStaffGuide:
        "Show this screen to restaurant staff and point to confirm. Each card shows the restaurant's language on top (large text) and your language underneath (smaller text).",
      uxWorkflowLabel: "Confirmation Card Workflow",
      uxWorkflowSteps: [
        "1. Auto-Generate (Verified Phrases)",
        "2. Review Bilingual Text (JA/EN)",
        "3. Edit If Needed (In-Memory Only)",
        "4. Present to Staff & Confirm",
      ],
      modeToggleToPresentBtn: "Switch to Staff Presentation View",
      modeToggleToReviewBtn: "Back to Review & Edit Mode",
      presentationModeActiveBanner:
        "[Staff Presentation View Active] Edit fields are hidden for clean presentation to restaurant staff. Mandatory safety notices and allergen tags remain locked.",
      presentationBlockedTitle: "[Cannot Present to Staff] Mandatory safety notices or questions cannot be displayed",
      presentationBlockedBody:
        "Staff presentation mode is blocked because no allergens are selected, the language pair is unsupported, a selected allergen lacks a verified phrase, or a manual edit is invalid (empty or over length). Please check your settings or edits.",
      verifiedBadgeTitle: "[Team-Reviewed Phrases (team_reviewed)]",
      verifiedBadgeBody:
        "Initial cards are generated exclusively from fixed phrases with a VerificationRecord (back-translation and official allergen term check). Machine translations and unverified drafts are never shown.",
      phraseVerificationTag: (level, reviewedAt) =>
        `Verified: ${level === "external_reviewed" ? "External Native Reviewed" : "Team-Reviewed (Back-Translated)"}${reviewedAt ? ` (${reviewedAt})` : ""}`,
      editedUnverifiedBadge: "Additional Note (Manual Edit / Unverified)",
      editedCardSummaryBanner:
        "[Additional User Notes Active (Unverified)] One or more question cards include a user-entered additional note. Edited text is unverified and is NOT automatically translated or verified. Locked mandatory verified questions are never deleted or replaced.",
      userMemoBoxTitle: "User's Additional Note (Manual Edit / Unverified — Not an App Safety Judgment)",
      userMemoDisclaimer:
        "* This box is an unverified free-text supplemental note entered by the user. It is NOT a safety/absence judgment, and is never automatically translated or verified. The locked verified question above cannot be deleted or replaced.",
      userMemoStoreLangUntranslated:
        "* The restaurant-language additional note has not been edited (no automatic translation is performed).",
      userMemoUserLangUntranslated:
        "* Your-language additional note has not been edited (no automatic translation is performed).",
      singleLangMismatchWarningTitle: "[Translation Mismatch Warning] Only one language has been edited",
      singleLangMismatchWarningBody:
        "Editing one language does NOT automatically translate or update the other language. Because the Japanese and English texts no longer match, please check both languages before presenting to staff.",
      originalVerifiedReferenceTitle: "Original Verified Phrase (team_reviewed — Retained)",
      editPhraseBtn: "Edit Text",
      closeEditPhraseBtn: "Close Editor",
      resetPhraseBtn: "Restore Original",
      resetAllEditsBtn: "Restore All Original Phrases",
      editStoreLangInputLabel: (storeLang) =>
        `Edit Restaurant Language Text (${storeLang === "ja" ? "日本語" : storeLang === "en" ? "English" : storeLang})`,
      editUserLangInputLabel: (userLang) =>
        `Edit Your Language Text (${userLang === "en" ? "English" : userLang === "ja" ? "日本語" : userLang})`,
      editNoAutoTranslationHint:
        "* Edits are kept in memory only and are never written back to phrase data, localStorage, or any server. No automatic translation is performed. Allergen labels, cross-contact warnings, and staff confirmation badges cannot be removed.",
      editInvalidEmptyError:
        "[Input Error] Text cannot be empty or contain only whitespace/invisible characters. Please enter visible text or restore the original phrase.",
      editInvalidLengthError: (max) =>
        `[Input Error] Text exceeds the maximum length of ${max} characters. Please shorten it.`,
      standaloneModeTitle: "[Standalone Card Mode (Without AI)]",
      standaloneModeBody:
        "Displaying verified confirmation cards directly from your language pair and selected allergens without AI analysis.",
      unsupportedPairTitle: "[Unsupported Language Pair]",
      unsupportedPairBody:
        "No verified confirmation card phrases exist for this language pair. Please select a supported pair (Japanese ⇄ English) in Settings.",
      noAllergensTitle: "[No Allergens Selected]",
      noAllergensBody:
        "No allergens are currently selected. Select at least one allergen in Settings to display allergen-specific question cards.",
      unverifiedAllergensTitle: "[Unverified Allergen Warning]",
      unverifiedAllergensBody:
        "Verified phrases are unavailable for some selected allergens. Unverified phrases are never displayed.",
      noticeSectionTitle: "1. Opening Notice (Show to Staff First)",
      allergenQuestionsTitle: "2. Allergen-Specific Questions (Including Broth, Extracts & Derivatives)",
      crossContactQuestionsTitle: "3. Broth, Seasonings, Shared Utensils & Frying Oil (Cross-Contact)",
      staffAnswerSectionTitle: "4. Staff Point-and-Tap Answer Options (4 Choices — Tap to Highlight)",
      staffAnswerSectionHelp:
        "Ask restaurant staff to point to or tap the applicable answer below to highlight it temporarily.",
      staffAnswerEphemeralNotice:
        "* This tap highlight is strictly for on-the-spot conversation assistance and is NEVER saved to your device (localStorage) or server. Regardless of which option is tapped, this app never records or guarantees food safety.",
      staffAnswerSelectedCaution:
        "[Caution] Even if 'No, it does not contain it' is selected, always check the broth/seasoning and kitchen cross-contact questions above, and make the final decision yourself.",
      clearStaffAnswerSelectionBtn: "Clear Highlight",
      storeLangBadgeLabel: (storeLang) =>
        `Restaurant Language (${storeLang === "ja" ? "日本語" : storeLang === "en" ? "English" : storeLang}) — Show to Staff`,
      userLangBadgeLabel: (userLang) =>
        `Your Language (${userLang === "en" ? "English" : userLang === "ja" ? "日本語" : userLang}) — For Your Reference`,
      aiDishStrongWarningTitle: "[WARNING] Dish names and assessments below are AI-inferred and UNVERIFIED (readBy: ai)",
      aiDishStrongWarningBody:
        "AI readings may contain misreadings or omissions (NOT a guarantee of safety). Always compare with the physical menu and confirm directly with restaurant staff.",
      pr4PlaceholderTitle: "[Verified Confirmation Card (PR4)]",
      pr4PlaceholderBody:
        "In accordance with our safety rules, machine-translated or unverified draft phrases are never displayed. Verified store-language cards (with VerificationRecord) and point-and-tap staff answer options are active.",
      summaryTitle: "Current Confirmation Context & Target Dishes",
      languagePairSummary: "Language Pair",
      selectedAllergensSummary: "Allergens to Confirm (All Require Staff Confirmation)",
      targetDishesSummary: "Target Dishes (Carried Over from AI Reading)",
      noSpecificDishesSelected: "General confirmation (all selected allergens)",
      alwaysConfirmChecklistTitle: "Critical Points to Confirm with Staff",
      alwaysConfirmChecklist: [
        "Whether any selected allergen is used as an ingredient (including unlisted or '-free' dishes)",
        "Whether broths (dashi), sauces, dressings, or seasonings contain the allergen",
        "Whether frying oil, grills, pots, cutting boards, or utensils are shared (cross-contact)",
      ],
      backToResultsBtn: "Back to Results",
      backToUploadBtn: "Back to Photo Upload",
      backToSettingsBtn: "Back to Settings",
    },
  },
};
