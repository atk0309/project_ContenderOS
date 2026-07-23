import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { fontVariables } from "@/lib/fonts";
import { railInitScript } from "@/lib/sidebar";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: BRAND_NAME,
  description: "Private CV-tailoring cockpit.",
};

// `viewportFit: "cover"` lets `env(safe-area-inset-*)` resolve to real insets (it's 0 without this),
// so the Ingest screen's sticky Apply bar clears the iPhone home indicator. Benign elsewhere — no
// other route uses edge-anchored fixed bars, and paged-media (the PDF export) insets are 0.
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Dark-first; both themes ship from one token set via `data-theme`. The inline script (first child
  // of <body>) sets it from localStorage / OS before paint, so light-mode users see no dark flash;
  // `suppressHydrationWarning` keeps React from complaining that the script mutated the attribute.
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <body>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted constant, runs pre-paint to avoid a theme flash */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted constant, runs pre-paint to set the rail width with no flash */}
        <script dangerouslySetInnerHTML={{ __html: railInitScript }} />
        {children}
      </body>
    </html>
  );
}
