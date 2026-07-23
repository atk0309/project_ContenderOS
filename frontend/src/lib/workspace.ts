/**
 * The active workspace id, client-safe.
 *
 * One workspace today: the backend seeds `default` and re-derives the caller's membership from the
 * session per request (invariant 8), so this id is never trusted on its own. `render/fetch.ts` has
 * the same constant but is server-only (it imports `BACKEND`), so it can't be imported into a
 * client component — hence this tiny client-safe copy. TODO: thread a real workspace id through
 * once multi-workspace / user management lands, and collapse the two.
 */
export const DEFAULT_WORKSPACE_ID = "default";
