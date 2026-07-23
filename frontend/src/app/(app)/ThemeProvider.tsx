"use client";

// Reads the theme the pre-hydration script (src/lib/theme.ts) already set on <html data-theme>, and
// exposes a toggle that flips the attribute + persists the choice. The attribute is the source of
// truth (so the script and React never disagree); React state just mirrors it for the toggle's icon.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { THEME_KEY, type ThemeName } from "@/lib/theme";

type ThemeContext = { theme: ThemeName; toggle: () => void };

const Ctx = createContext<ThemeContext | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>("dark");

  // Sync from the attribute the init script set (avoids assuming a default that could mismatch).
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: ThemeName = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // private mode / storage disabled — the in-memory toggle still works for this session.
      }
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
