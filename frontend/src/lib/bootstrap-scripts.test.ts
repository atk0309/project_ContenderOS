import { describe, expect, it } from "vitest";
import { RAIL_KEY, railInitScript } from "./sidebar";
import { THEME_KEY, themeInitScript } from "./theme";

describe("pre-paint bootstrap scripts", () => {
  it("keeps the static theme storage key aligned with THEME_KEY", () => {
    expect(themeInitScript).toContain(`localStorage.getItem('${THEME_KEY}')`);
  });

  it("keeps the static rail storage key aligned with RAIL_KEY", () => {
    expect(railInitScript).toContain(`localStorage.getItem('${RAIL_KEY}')`);
  });
});
