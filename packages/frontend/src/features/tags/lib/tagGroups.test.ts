import { describe, expect, it } from "vitest";
import { groupHref, groupLabel, groupOf, groupOptions } from "./tagGroups";

const groups = {
  tags: { serafuku: "attire", thighhighs: "legwear", pantyhose: "legwear", smile: "face_tags" },
  categories: { attire: "attire_and_body_accessories", legwear: "attire_and_body_accessories", face_tags: "body" },
};

describe("tag groups", () => {
  it("names a group for people", () => {
    expect(groupLabel("neck_and_neckwear")).toBe("Neck and neckwear");
    expect(groupLabel("face_tags")).toBe("Face");
    expect(groupHref("hair_color")).toBe("/tags/groups/hair_color");
  });

  it("finds a tag's group, any case", () => {
    expect(groupOf(groups, "Serafuku")).toBe("attire");
    expect(groupOf(groups, "fav")).toBeNull();
    expect(groupOf(undefined, "serafuku")).toBeNull();
  });

  it("lists groups under their category, with sizes", () => {
    const opts = groupOptions(groups);
    expect(opts.map((o) => o.value)).toEqual(["attire", "legwear", "face_tags"]);
    expect(opts[1]).toMatchObject({ label: "Legwear", hint: "2", group: "Attire and body accessories" });
    expect(opts[2].group).toBe("Body");
  });
});
