// The desktop left rail can be collapsed to an icon strip to reclaim width for the workspace, and
// pinned back open. The choice persists in localStorage; the init script below runs before paint
// (first child of <body>, root layout) so the rail is the right width on the first frame — no flash,
// no SSR/client mismatch. The `data-rail` attribute on <html> is the source of truth (CSS reads it);
// React state just mirrors it for the toggle control. Mirrors src/lib/theme.ts exactly.
export type RailState = "expanded" | "collapsed";

export const RAIL_KEY = "contender-rail";

export const railInitScript = `(function(){try{var r=localStorage.getItem(${JSON.stringify(
  RAIL_KEY,
)});document.documentElement.dataset.rail=(r==='collapsed')?'collapsed':'expanded';}catch(e){document.documentElement.dataset.rail='expanded';}})();`;
