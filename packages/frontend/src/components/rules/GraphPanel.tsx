import { useMemo, useState, type Ref } from "react";
import { Plus, Search } from "lucide-react";
import { JsonTree, collectMatches } from "../GraphTree";
import { FIELD_LABEL, type RuleField } from "../../lib/rules";

/**
 * The sample's raw graph: click a value to pin it to the active field, or
 * search it by node id, class_type or prompt word and jump to a match.
 */
export function GraphPanel({
  graph,
  scrollRef,
  activeField,
  marks,
  onPin,
  onReveal,
}: {
  graph: unknown;
  /** The scrolling box, for revealing a path in it. */
  scrollRef: Ref<HTMLDivElement>;
  activeField: RuleField;
  marks: Map<string, string>;
  onPin: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  // Search *within* the selected sample graph: find a node by id, class_type, or
  // a prompt word and see where it lives so its dot-path can be pinned.
  const [graphQuery, setGraphQuery] = useState("");

  // Matches surfaced at the top of the graph panel so a hit deep in a large graph
  // is reachable instead of scrolling to find it.
  const matches = useMemo(
    () => (graph && graphQuery.trim() ? collectMatches(graph, graphQuery) : []),
    [graph, graphQuery],
  );

  return (
    <div
      ref={scrollRef}
      className="rounded-lg border border-line bg-canvas p-3 overflow-auto max-h-[70vh]"
    >
      {/* Sticky header: stays put while the tree scrolls, so the search
          box and the surfaced matches are always reachable. */}
      <div className="sticky -top-3 -mx-3 -mt-3 px-3 pt-3 pb-2 bg-canvas z-10 border-b border-line">
        <div className="text-xs text-neutral-400 mb-2">
          Sample graph. Click a value to pin it to{" "}
          <span className="text-brand-300">{FIELD_LABEL[activeField]}</span>
        </div>
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
          />
          <input
            type="search"
            value={graphQuery}
            onChange={(e) => setGraphQuery(e.target.value)}
            placeholder="Find a node by id, class_type, or prompt word (e.g. masterpiece)"
            className="w-full pl-8 pr-2 py-1.5 rounded-lg bg-surface border border-line text-xs placeholder:text-faint focus:border-brand-500/70 focus:outline-none"
          />
        </div>
        {graphQuery.trim() && (
          <div className="mt-2">
            <div className="text-2xs text-neutral-400 mb-1">
              {matches.length === 0
                ? "No matches in this graph"
                : `${matches.length} match${matches.length > 1 ? "es" : ""}. Click to jump to it; + pins to ${FIELD_LABEL[activeField]}`}
            </div>
            <div className="max-h-40 overflow-auto space-y-0.5">
              {matches.slice(0, 100).map((m) => (
                <div
                  key={m.path}
                  className="flex items-baseline gap-1 rounded hover:bg-brand-500/10"
                >
                  <button
                    onClick={() => onReveal(m.path)}
                    title={`Jump to ${m.path}`}
                    className="flex-1 min-w-0 text-left flex items-baseline gap-2 px-1.5 py-1 font-mono text-2xs"
                  >
                    <span className="text-brand-300 shrink-0">{m.path}</span>
                    <span className="text-neutral-400 truncate">
                      {String(m.value)}
                    </span>
                  </button>
                  <button
                    onClick={() => onPin(m.path)}
                    title={`Pin ${m.path} → ${FIELD_LABEL[activeField]}`}
                    aria-label={`Pin ${m.path}`}
                    className="shrink-0 px-1.5 py-1 text-faint hover:text-brand-300"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {graph ? (
        <div className="font-mono text-xs leading-relaxed">
          <JsonTree
            value={graph}
            path=""
            onPin={onPin}
            query={graphQuery}
            marks={marks}
          />
        </div>
      ) : (
        <div className="text-faint text-sm">Loading graph…</div>
      )}
    </div>
  );
}
