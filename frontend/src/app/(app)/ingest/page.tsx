import { redirect } from "next/navigation";

// Import was absorbed into the Master editor (C4): it is now a modal opened from Master's "Add source"
// button, not a standalone screen. This route survives only as a redirect so existing links/bookmarks
// (and the old nav target) still land on the import flow — Master reads `?import=1` and auto-opens the
// modal. The flow itself lives in `./ImportModal`.
export default function ImportRedirect() {
  redirect("/master?import=1");
}
