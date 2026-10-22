import { ChevronDown, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge, Picker } from "../ui";
import { cn } from "../../lib/cn";
import type { Generator } from "../../lib/generate";
import { SET_UP, testState, workflowOptions, type TestState } from "../../lib/workflow";

const STATE: Record<TestState, { tone: "success" | "warning" | "danger" | "brand"; label: string }> = {
  ready: { tone: "success", label: "Ready" },
  untested: { tone: "warning", label: "Needs a test run" },
  running: { tone: "brand", label: "Testing" },
  waiting: { tone: "brand", label: "Waiting for scan" },
  failed: { tone: "danger", label: "Test failed" },
};

export function TestBadge({ gen }: { gen: Generator }) {
  const s = STATE[testState(gen)];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/**
 * The Generate header's workflow picker: Built-in and every set-up workflow
 * with its test state, "Set up a workflow" first (opens setup), "Manage
 * workflows" at the foot.
 */
export function WorkflowPicker({
  generators,
  value,
  onChange,
}: {
  generators: readonly Generator[];
  value: string;
  onChange: (id: string) => void;
}) {
  const navigate = useNavigate();
  const chosen = generators.find((g) => g._id === value);
  const options = workflowOptions(generators, value).map((o) => {
    const g = generators.find((x) => x._id === o.value)!;
    return { ...o, hint: <TestBadge gen={g} /> };
  });
  // The page's status line says when the chosen one needs its test run.
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2">
      <Picker
        className="min-w-0"
        aria-label="Workflow"
        value={value}
        options={options}
        searchable={generators.length > 6}
        checks={false}
        align="right"
        pinned={() => ({
          value: SET_UP,
          label: "Set up a workflow",
          icon: <Plus size={14} className="text-muted" />,
        })}
        onChange={(v) => (v === SET_UP ? navigate("/generate/workflows/new") : onChange(v))}
        trigger={({ open }) => (
          <span
            className={cn(
              "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-line bg-raised px-3 text-sm text-neutral-100 hover:border-line-strong",
              open && "border-brand-500/70",
            )}
          >
            <span className="truncate" title={chosen?.name}>
              {chosen?.name ?? "Built-in"}
            </span>
            <ChevronDown size={14} className={cn("shrink-0 text-faint transition-transform", open && "rotate-180")} />
          </span>
        )}
        footer={
          <button
            type="button"
            // Mousedown would blur the list first; the click is what navigates (keys too).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => navigate("/settings?section=comfyui#workflows")}
            className="w-full rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-white/[0.06] hover:text-neutral-100"
          >
            Manage workflows
          </button>
        }
      />
    </div>
  );
}
