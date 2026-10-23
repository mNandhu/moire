import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Input } from "./ui/Input";
import { Skeleton } from "./ui/Skeleton";
import { useToast } from "./Toasts";
import { JsonTree, collectMatches } from "./GraphTree";
import { useRulesetSession } from "../hooks/useRulesetSession";
import { fetchSignatures, type GenMeta, type RuleField } from "../lib/gen";
import { cn } from "../lib/cn";
import { errorText } from "../lib/api";

type Side = "prompt" | "negative";
const SIDES: { key: Side; label: string }[] = [
  { key: "prompt", label: "Positive" },
  { key: "negative", label: "Negative" },
];

/**
 * Pins a workflow's prompt fields from its sample graph, for an image whose
 * prompt was only guessed by keywords: click the node value that holds the
 * text. The pin belongs to the whole workflow (its Ruleset), so saving re-reads
 * every image that shares it.
 */
export function ResolvePromptDialog({
  open,
  onClose,
  gen,
  field: first,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  gen: GenMeta;
  /** The field to pin first. */
  field: Side;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [field, setField] = useState<Side>(first);
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState(false);
  const session = useRulesetSession({
    notify: push,
    onSaved: () => {
      onSaved();
      onClose();
    },
  });
  const { fields, graph, loading, isDirty, busy, loadFailed, selected } = session;
  const sig = gen.workflow_sig;
  const selectRef = useRef(session.selectSig);
  selectRef.current = session.selectSig;
  const pushRef = useRef(push);
  pushRef.current = push;

  useEffect(() => {
    if (!open) return;
    setField(first);
    setQuery("");
  }, [open, first]);

  useEffect(() => {
    if (!open || !sig) return;
    let live = true;
    setMissing(false);
    fetchSignatures()
      .then((rows) => {
        const row = rows.find((r) => r.workflow_sig === sig);
        if (live && row) void selectRef.current(row);
        else if (live) {
          setMissing(true);
          pushRef.current("This workflow isn't in the rules list yet", "error");
        }
      })
      .catch((e) => {
        if (!live) return;
        setMissing(true);
        pushRef.current(`Failed to load the workflow: ${errorText(e)}`, "error");
      });
    return () => {
      live = false;
    };
  }, [open, sig]);

  // Where each field's text was guessed from, unless it is pinned already.
  const marks = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of SIDES) {
      const p = gen.guessed?.includes(s.key) ? gen.guess_paths?.[s.key] : null;
      if (p && !(fields[s.key] ?? []).length) m.set(p, `Guessed ${s.label.toLowerCase()}`);
    }
    return m;
  }, [gen, fields]);
  const matches = useMemo(() => (graph && query.trim() ? collectMatches(graph, query) : []), [graph, query]);
  const pinned = fields[field as RuleField] ?? [];
  const pin = (path: string) => session.pinPath(field, path);
  // The field's guess, first: a row up top to pin it in one click, and the
  // tree scrolled to where it sits.
  const guessPath = gen.guessed?.includes(field) ? (gen.guess_paths?.[field] ?? null) : null;
  const guessValue = graph != null && guessPath ? valueAt(graph, guessPath) : undefined;
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!guessPath || graph == null) return;
    const leaf = tree.current?.querySelector(`[data-graph-path="${CSS.escape(guessPath)}"]`);
    leaf?.scrollIntoView?.({ block: "center" });
  }, [guessPath, graph]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Resolve prompt"
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!isDirty || busy || loading || loadFailed} onClick={() => void session.save()}>
            Save and re-read
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div role="group" aria-label="Field" className="inline-flex h-8 rounded-lg border border-line bg-raised p-0.5">
          {SIDES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={field === s.key}
              onClick={() => setField(s.key)}
              className={cn(
                "rounded-md px-3 text-xs",
                field === s.key ? "bg-surface text-neutral-50" : "text-muted hover:text-neutral-100",
                gen.guessed?.includes(s.key) && "after:ml-1 after:text-amber-300 after:content-['•']",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {pinned.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pinned.map((p) => (
              <span key={p} className="inline-flex items-center gap-1 rounded-md border border-brand-500/40 bg-brand-500/10 px-1.5 py-0.5 font-mono text-2xs text-brand-100">
                {p}
                <button type="button" aria-label={`Unpin ${p}`} onClick={() => session.removePath(field, p)} className="opacity-60 hover:opacity-100">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {guessPath && guessValue !== undefined && !pinned.includes(guessPath) && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-2.5 py-1.5">
            <span className="shrink-0 text-2xs text-amber-300">Guessed</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-300" title={typeof guessValue === "string" ? guessValue : JSON.stringify(guessValue)}>
              {JSON.stringify(guessValue)}
            </span>
            <Button size="sm" onClick={() => pin(guessPath)} title={`Pin ${guessPath}`}>
              Use this
            </Button>
          </div>
        )}
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a node or a prompt word" aria-label="Search the graph" className="pl-8" />
        </div>
        <div ref={tree} className="max-h-[55vh] overflow-auto rounded-lg border border-line bg-canvas/60 p-2 font-mono text-xs">
          {missing ? (
            <div className="text-muted">No sample graph for this workflow.</div>
          ) : !selected || loading || graph == null ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : (
            <>
              {matches.length > 0 && (
                <div className="mb-2 space-y-0.5 border-b border-line pb-2">
                  {matches.slice(0, 20).map((m) => (
                    <button key={m.path} type="button" onClick={() => pin(m.path)} className="block w-full truncate rounded px-1 text-left hover:bg-brand-500/10" title={`Pin ${m.path}`}>
                      <span className="text-emerald-300">{JSON.stringify(m.value)}</span> <span className="text-2xs text-faint">{m.path}</span>
                    </button>
                  ))}
                </div>
              )}
              <JsonTree value={graph} path="" onPin={pin} query={query} marks={marks} />
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** The value at a dot-path (`12.inputs.text`) in the graph, else undefined. */
function valueAt(graph: unknown, path: string): unknown {
  let at: unknown = graph;
  for (const k of path.split(".")) {
    if (at == null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[k];
  }
  return at;
}
