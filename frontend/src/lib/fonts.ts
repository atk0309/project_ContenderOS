// The three typefaces from the design: Archivo (UI), IBM Plex Mono (labels/utility),
// Source Serif 4 (the CV document). Self-hosted via next/font so they're bundled — the same
// fonts must live in the renderer image for byte-stable PDFs (see docs/architecture/renderer.md).
import { Archivo, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";

export const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

export const fontVariables = `${archivo.variable} ${plexMono.variable} ${sourceSerif.variable}`;
