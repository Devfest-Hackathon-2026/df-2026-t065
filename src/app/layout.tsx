import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AllergyBridge",
  description:
    "Helps travelers with food allergies understand menus and ask restaurant staff. It does not decide whether food is safe.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          margin: 0,
          padding: "12px",
          lineHeight: 1.6,
          backgroundColor: "#f8efdf",
          color: "#0f172a",
        }}
      >
        {children}
      </body>
    </html>
  );
}
