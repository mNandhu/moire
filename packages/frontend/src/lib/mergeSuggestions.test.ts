import { describe, expect, it } from "vitest";
import { defaultPicked, groupByKind, reconcilePicked } from "./mergeSuggestions";
import type { MergeSuggestion } from "./queries";

const list: MergeSuggestion[] = [
  { from: "black_heart_pasties", to: ["heart_pasties"], kind: "strip", images: 11 },
  { from: "long_white_hair", to: ["long_hair", "white_hair"], kind: "split", images: 174 },
  { from: "blowjob", to: ["fellatio"], kind: "alias", images: 3 },
];

describe("merge suggestions", () => {
  it("ticks everything but a dropped colour", () => {
    expect([...defaultPicked(list)].sort()).toEqual(["blowjob", "long_white_hair"]);
  });

  it("keeps the user's ticks across a new list and defaults only new names", () => {
    const added: MergeSuggestion = { from: "naked", to: ["nude"], kind: "alias", images: 5 };
    const picked = new Set(["black_heart_pasties"]); // unticked the others
    expect([...reconcilePicked(picked, list, [...list.slice(0, 2), added])].sort()).toEqual([
      "black_heart_pasties",
      "naked",
    ]);
  });

  it("groups by kind, most certain first, skipping empty kinds", () => {
    expect(groupByKind(list).map((g) => [g.kind, g.rows.map((r) => r.from)])).toEqual([
      ["alias", ["blowjob"]],
      ["split", ["long_white_hair"]],
      ["strip", ["black_heart_pasties"]],
    ]);
  });
});
