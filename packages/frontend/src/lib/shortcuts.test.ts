import { describe, expect, it } from "vitest";
import { SHORTCUT_SPECS, shortcutGroups, shortcutPage } from "./shortcuts";

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
    expect(shortcutGroups("/generate")[0].page).toBe("generate");
  });
});

describe("shortcut specs", () => {
  // Bound outside any module that names the spec: Tab is the shared
  // suggestion-list key (tagSuggest suggestKeyAction), not Generate's own.
  const BOUND_GENERICALLY = new Set(["GENERATE.suggest"]);

  it("are each bound by some handler", () => {
    const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!./shortcuts.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const text = Object.values(sources).join("\n");
    const unbound = SHORTCUT_SPECS.flatMap(({ name, specs }) => Object.keys(specs).map((k) => `${name}.${k}`)).filter(
      (ref) => !BOUND_GENERICALLY.has(ref) && !text.includes(ref),
    );
    expect(unbound).toEqual([]);
  });

  it("write a row for every group, in the reference's order", () => {
    expect(shortcutGroups("/settings").map((g) => g.title)).toEqual([
      "Everywhere",
      "Gallery",
      "Triage",
      "Filter and select",
      "Image",
      "Generate",
      "Batch results",
    ]);
    expect(shortcutGroups("/").find((g) => g.title === "Gallery")?.keys[5]).toEqual(["+ / -", "Larger / smaller thumbnails"]);
  });
});
