import { describe, expect, it } from "vitest";
import { checkedAgo } from "./version";

describe("checkedAgo", () => {
  const now = 1_000_000;
  it("rounds down to the unit", () => {
    expect(checkedAgo(now - 5, now)).toBe("just now");
    expect(checkedAgo(now - 5 * 60 - 30, now)).toBe("5 min ago");
    expect(checkedAgo(now - 3 * 3600 - 59, now)).toBe("3 h ago");
    expect(checkedAgo(now - 86400, now)).toBe("1 day ago");
    expect(checkedAgo(now - 3 * 86400, now)).toBe("3 days ago");
  });
  it("treats a future time as now", () => {
    expect(checkedAgo(now + 100, now)).toBe("just now");
  });
});
