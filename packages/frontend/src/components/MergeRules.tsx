import { Undo2 } from "lucide-react";
import type { TagRule } from "../lib/queries";
import { formatTag } from "../lib/tags";
import { Button } from "./ui/Button";

/** The prompt-tag merge (and split) rules, each with an Undo. */
export function MergeRules({ rules, onUndo }: { rules: TagRule[]; onUndo: (from: string) => void }) {
  return (
    <div className="mb-6 rounded-xl border border-white/5 bg-surface shadow-panel divide-y divide-white/5">
      {rules.map((a) => (
        <div key={a.from} className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="truncate text-muted">{formatTag(a.from)}</span>
          <span className="text-faint">→</span>
          <span className="truncate font-medium">{a.to.map(formatTag).join(" + ")}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={() => onUndo(a.from)}
            title={`Stop merging “${formatTag(a.from)}”; images get their own prompt's name back`}
          >
            <Undo2 size={14} /> Undo
          </Button>
        </div>
      ))}
    </div>
  );
}
