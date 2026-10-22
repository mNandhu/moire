import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Tooltip } from "./ui/Tooltip";
import { formatTag } from "../lib/tags";
import { KIND_LABEL, KIND_TIP, defaultPicked, groupByKind } from "../lib/mergeSuggestions";
import type { MergeSuggestion } from "../lib/queries";

/**
 * Danbooru-backed merge and split rules for prompt tags, to accept in bulk.
 * A new list (after a merge) starts again from its default ticks.
 */
export function MergeSuggestions({
  suggestions,
  onAccept,
}: {
  suggestions: MergeSuggestion[];
  onAccept: (rules: { from: string; to: string[] }[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState(() => defaultPicked(suggestions));
  const [shown, setShown] = useState(suggestions);
  if (shown !== suggestions) {
    setShown(suggestions);
    setPicked(defaultPicked(suggestions));
  }
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupByKind(suggestions), [suggestions]);

  const toggle = (names: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });

  const accept = async () => {
    setBusy(true);
    try {
      await onAccept(
        suggestions.filter((s) => picked.has(s.from)).map((s) => ({ from: s.from, to: s.to })),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-xl border border-white/5 bg-surface shadow-panel">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5">
        <Checkbox
          checked={picked.size === suggestions.length}
          onChange={(on) => toggle(suggestions.map((s) => s.from), on)}
          label={`${picked.size.toLocaleString()} of ${suggestions.length.toLocaleString()}`}
        />
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          disabled={busy || picked.size === 0}
          onClick={() => void accept()}
        >
          <Check size={14} /> {busy ? "Merging…" : "Merge"}
        </Button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {groups.map(({ kind, rows }) => {
          const names = rows.map((r) => r.from);
          const on = names.filter((n) => picked.has(n)).length;
          return (
            <section key={kind}>
              <div className="sticky top-0 z-10 flex items-center gap-3 bg-surface px-4 py-2 border-b border-white/5">
                <Checkbox
                  checked={on === names.length}
                  onChange={(v) => toggle(names, v)}
                  aria-label={`All ${KIND_LABEL[kind].toLowerCase()}`}
                />
                <Tooltip content={KIND_TIP[kind]}>
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {KIND_LABEL[kind]}
                  </span>
                </Tooltip>
                <span className="text-xs text-faint">{rows.length.toLocaleString()}</span>
              </div>
              <div className="divide-y divide-white/5">
                {rows.map((s) => (
                  <div key={s.from} className="flex items-center gap-3 px-4 py-1.5 text-sm">
                    <Checkbox
                      checked={picked.has(s.from)}
                      onChange={(v) => toggle([s.from], v)}
                      aria-label={formatTag(s.from)}
                    />
                    <span className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2">
                      <span className="text-muted break-words">{formatTag(s.from)}</span>
                      <span className="text-faint">→</span>
                      <span className="font-medium break-words">
                        {s.to.map(formatTag).join(" + ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-faint">
                      {s.images.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
