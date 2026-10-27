import { Badge } from "../ui";
import type { Generator } from "../../lib/generate";
import { testState, type TestState } from "../../lib/generatorRunBar";

const STATE: Record<TestState, { tone: "success" | "warning" | "danger" | "brand"; label: string }> = {
  ready: { tone: "success", label: "Ready" },
  untested: { tone: "warning", label: "Needs a test run" },
  running: { tone: "brand", label: "Testing" },
  waiting: { tone: "brand", label: "Waiting for scan" },
  failed: { tone: "danger", label: "Test failed" },
};

/** A workflow's test-run state as a badge. */
export function TestBadge({ gen }: { gen: Generator }) {
  const s = STATE[testState(gen)];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
