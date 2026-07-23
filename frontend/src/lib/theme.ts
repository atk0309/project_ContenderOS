// Theme is dark-first; both palettes ship from one token set in globals.css, switched by the
// `data-theme` attribute on <html>. The user's choice persists in localStorage; with no choice we
// follow the OS. The init script below runs before paint (first child of <body> in the root layout)
// so the correct palette is set before the first frame — no flash, no SSR/client mismatch.
export type ThemeName = "dark" | "light";

export const THEME_KEY = "contender-theme";

// Static source by design: never interpolate runtime data into executable bootstrap code.
// bootstrap-scripts.test.ts pins the duplicated storage-key literal to THEME_KEY.
export const themeInitScript =
  "(function(){try{var t=localStorage.getItem('contender-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();";
