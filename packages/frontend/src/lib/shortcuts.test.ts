import { describe, expect, it } from "vitest";
import { shortcutGroups, shortcutPage } from "./shortcuts";

describe("shortcutGroups", () => {
  it("puts the page's own keys first, then everywhere's", () => {
    expect(shortcutPage("/image/L1:a.png")).toBe("image");
    const groups = shortcutGroups("/image/L1:a.png");
    expect(groups[0].page).toBe("image");
    expect(groups[1].page).toBe("everywhere");
  });

  it("leads with everywhere's keys on a page with none of its own", () => {
    expect(shortcutGroups("/settings")[0].page).toBe("everywhere");
    expect(shortcutGroups("/")[0].page).toBe("gallery");
  });
});
