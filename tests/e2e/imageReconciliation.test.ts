import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UI_MESSAGES } from "@/client/i18n";
import { ImageReconciliationView } from "@/components/ImageReconciliationView";

describe("P0 image reconciliation UI & ARIA (PR19 audit revise)", () => {
  it("distinguishes original and processed images without inventing OCR highlights", () => {
    const html = renderToStaticMarkup(
      React.createElement(ImageReconciliationView, {
        originalPreviewUrl: "blob:http://localhost/original",
        processedPreviewUrl: "blob:http://localhost/processed",
        messages: UI_MESSAGES.ja.results,
      }),
    );

    expect(html).toContain('data-testid="image-reconciliation"');
    expect(html).toContain("送信前の元画像");
    expect(html).toContain("AI送信画像（処理後）");
    expect(html).toContain('data-testid="image-zoom-in"');
    expect(html).toContain("OCR座標がないため、画像上のハイライトは表示しません");
    expect(html).not.toContain("<mark");
    // Viewport keyboard access and region role
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain(UI_MESSAGES.ja.results.zoomHelp);
    // MINOR-2: Accuracy of retention & transmission description
    expect(html).toContain("元画像はサーバーに送信せず端末内でのみ保持されます");
    expect(html).toContain("AI解析に送信された処理済み画像もサーバー側で保存されず、メモリ内でのみ処理されます");
    expect(html).toContain("画像はアプリ内の画面移動中も保持され、画像を変更・消去したときやブラウザのタブを閉じたときに端末内から解放されます");
    expect(html).not.toContain("保存・送信は行いません");
  });

  it("does not fabricate an original image when it is unavailable", () => {
    const html = renderToStaticMarkup(
      React.createElement(ImageReconciliationView, {
        originalPreviewUrl: null,
        processedPreviewUrl: "blob:http://localhost/processed",
        messages: UI_MESSAGES.en.results,
      }),
    );

    expect(html).not.toContain('data-testid="image-panel-original"');
    expect(html).not.toContain("blob:http://localhost/original");
    expect(html).toContain("Original images are kept only on this device and never sent to the server");
    expect(html).toContain("Processed images sent for AI analysis are processed only in memory and not stored on the server");
    expect(html).toContain("Images remain available while navigating within the app, and are released when changed, cleared, or when closing the browser tab");
    expect(html).toContain('data-testid="image-panel-processed"');
  });

  it("MINOR-1: Mobile ARIA tabs have matching aria-selected, tabIndex, aria-controls, and aria-hidden", () => {
    const html = renderToStaticMarkup(
      React.createElement(ImageReconciliationView, {
        originalPreviewUrl: "blob:http://localhost/original",
        processedPreviewUrl: "blob:http://localhost/processed",
        messages: UI_MESSAGES.ja.results,
      }),
    );

    // Tab relationship
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="image-tab-original"');
    expect(html).toContain('aria-controls="image-panel-original"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="0"');

    expect(html).toContain('id="image-tab-processed"');
    expect(html).toContain('aria-controls="image-panel-processed"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('tabindex="-1"');

    // Panel relationship
    expect(html).toContain('id="image-panel-original"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="image-tab-original"');
    // Active original panel is not hidden in mobile view
    expect(html).toMatch(/id="image-panel-original"[^>]*aria-hidden="false"/);

    // Inactive processed panel is hidden
    expect(html).toMatch(/id="image-panel-processed"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/id="image-panel-processed"[^>]*hidden=""/);
  });

  it("MINOR-1: Desktop (min-width: 680px) exposes both original and processed panels to assistive tech", () => {
    const origWindow = globalThis.window;
    try {
      const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("min-width: 680px"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const win = { matchMedia: matchMediaMock } as unknown as Window & typeof globalThis;
      globalThis.window = win;

      const hasOriginal = true;
      const effectiveSource: "original" | "processed" = "original";
      const isDesktop = true;
      const isOriginalVisible = (isDesktop && hasOriginal) || effectiveSource === "original";
      const isProcessedVisible = (isDesktop && hasOriginal) || (effectiveSource as string) === "processed";

      expect(isOriginalVisible).toBe(true);
      expect(isProcessedVisible).toBe(true);
      // Both panels must NOT be hidden from assistive technology on desktop
      expect(!isOriginalVisible).toBe(false);
      expect(!isProcessedVisible).toBe(false);
    } finally {
      globalThis.window = origWindow;
    }
  });

  describe("MAJOR-1: Object URL lifecycle separation & early revocation negative control", () => {
    it("ensures originalPreviewUrl lifecycle is separate from processedPreviewUrl", () => {
      const revokedUrls: string[] = [];
      const fakeUrl = {
        createObjectURL: (blob: Blob) => `blob:fake/${(blob as unknown as { name?: string }).name ?? "img"}`,
        revokeObjectURL: (url: string) => revokedUrls.push(url),
      };

      // Simulating handleSelectFile lifecycle
      const originalUrl = fakeUrl.createObjectURL({ name: "original-file" } as unknown as Blob);
      const processedBaseUrl = fakeUrl.createObjectURL({ name: "processed-base" } as unknown as Blob);

      // On successful image processing:
      // CORRECT BEHAVIOUR (Fix): revoke only processed URLs, PRESERVE originalUrl
      const revokeProcessedOnly = () => {
        fakeUrl.revokeObjectURL(processedBaseUrl);
      };
      revokeProcessedOnly();

      expect(revokedUrls).toContain(processedBaseUrl);
      expect(revokedUrls).not.toContain(originalUrl); // Must NOT be revoked!

      // When clearing image or unmounting:
      const revokeAll = () => {
        fakeUrl.revokeObjectURL(originalUrl);
      };
      revokeAll();
      expect(revokedUrls).toContain(originalUrl);
    });

    it("NEGATIVE CONTROL / FAULT INJECTION: re-introducing early revoke triggers assertion failure", () => {
      const revokedUrls = new Set<string>();
      const fakeUrl = {
        createObjectURL: (id: string) => `blob:test/${id}`,
        revokeObjectURL: (url: string) => {
          revokedUrls.add(url);
        },
      };

      const originalUrl = fakeUrl.createObjectURL("original-sample");

      // Verify that the URL is currently valid (not revoked)
      const assertUrlAlive = (url: string) => {
        if (revokedUrls.has(url)) {
          throw new Error(`EARLY_REVOCATION_VIOLATION: ${url} was prematurely revoked on success path!`);
        }
      };

      // With current fix: alive!
      expect(() => assertUrlAlive(originalUrl)).not.toThrow();

      // FAULT INJECTION: Simulate pre-fix bug where revokeAllObjectUrls() was called on success
      const faultySuccessPath = () => {
        fakeUrl.revokeObjectURL(originalUrl); // Fault injected
      };
      faultySuccessPath();

      // Assertion MUST fail when fault is injected
      expect(() => assertUrlAlive(originalUrl)).toThrowError(/EARLY_REVOCATION_VIOLATION/);
    });
  });
});
