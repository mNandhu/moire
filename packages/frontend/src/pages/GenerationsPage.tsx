import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { History, ImageOff, Layers, Loader2, Search } from "lucide-react";
import { Badge, EmptyState, Input, PageBody, PageHeader } from "../components/ui";
import { batchLine, coverAspect, dayLabel, scrubIndex, stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { thumbUrl, useBatches, type BatchSummary } from "../lib/generate";
import { cn } from "../lib/cn";
import { fuzzyRank } from "../lib/fuzzy";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type Show = "all" | "running" | "failed";

// How far each image behind the front one peeks out, up and to the right.
const PEEK = 6;

/**
 * A batch's images as a stacked deck at the batch's own shape: the first
 * image whole in front, up to two more peeking out behind it, and a count.
 * Moving the pointer across the cover (or arrow keys on the card) flips
 * through them, a strip per image, with a thin bar showing where you are.
 */
function Cover({ b, at, onAt }: { b: BatchSummary; at: number; onAt: (i: number) => void }) {
  const ids = b.thumbs;
  if (!ids.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-xs text-faint">
        {b.state === "running" || b.state === "paused" ? (
          <Loader2 size={20} className="animate-spin" />
        ) : (
          <>
            <ImageOff size={20} />
            {b.images > 0 && "All rejected"}
          </>
        )}
      </div>
    );
  }
  const n = ids.length;
  const behind = Math.min(n - 1, 2);
  // The card at depth `d` (0 in front), all the same size, each one further
  // back shifted up and right by PEEK.
  const frame = (d: number): React.CSSProperties => ({
    top: PEEK * (behind - d),
    right: PEEK * (behind - d),
    bottom: PEEK * d,
    left: PEEK * d,
  });
  const count = Math.max(b.kept, n);
  return (
    <div
      // A deck sits a little in from the card's edge, so it reads as a stack.
      className={cn("absolute", behind ? "inset-2" : "inset-0")}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onAt(scrubIndex(e.clientX - r.left, r.width, n));
      }}
      onMouseLeave={() => onAt(0)}
    >
      {Array.from({ length: behind }, (_, k) => behind - k).map((d) => (
        <div
          key={d}
          aria-hidden
          className="absolute overflow-hidden rounded-md bg-raised shadow-[0_1px_3px_rgb(0_0_0/0.5)]"
          style={frame(d)}
        >
          <img
            src={thumbUrl(ids[(at + d) % n])}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover opacity-50"
          />
        </div>
      ))}
      <div
        className={cn("absolute overflow-hidden bg-raised", behind ? "rounded-md shadow-[0_2px_6px_rgb(0_0_0/0.55)]" : "")}
        style={frame(0)}
      >
        {ids.map((id, i) => (
          <img
            key={id}
            src={thumbUrl(id)}
            alt=""
            loading="lazy"
            className={cn("absolute inset-0 h-full w-full object-cover", i !== at && "opacity-0")}
          />
        ))}
        {n > 1 && (
          <>
            <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-white">
              <Layers size={11} aria-hidden />
              {count}
            </span>
            <div
              aria-hidden
              className="absolute inset-x-1.5 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            >
              {ids.map((id, i) => (
                <span key={id} className={cn("h-0.5 flex-1 rounded-full", i === at ? "bg-white" : "bg-white/30")} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BatchCard({ b }: { b: BatchSummary }) {
  const [at, setAt] = useState(0);
  const n = b.thumbs.length;
  return (
    <Link
      to={`/generations/${b._id}`}
      aria-label={`${b.name}, ${batchLine(b)}`}
      onKeyDown={(e) => {
        if (n < 2 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        setAt((i) => (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n);
      }}
      onBlur={() => setAt(0)}
      className="group block overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong"
    >
      <div className="relative bg-canvas" style={{ aspectRatio: coverAspect(b.width, b.height) }}>
        <Cover b={b} at={Math.min(at, Math.max(0, n - 1))} onAt={setAt} />
        {b.state !== "done" && (
          <Badge tone={stateTone(b.state)} className="absolute left-2 top-2 shadow-panel">
            {STATE_LABEL[b.state]}
          </Badge>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-neutral-100 group-hover:text-white">{b.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-faint">{whenLabel(b.created_at)}</span>
        </div>
        <div className="truncate text-xs text-faint" title={b.generator ?? undefined}>
          {batchLine(b)}
        </div>
      </div>
    </Link>
  );
}

export default function GenerationsPage() {
  useDocumentTitle("Generations");
  const { data, isLoading } = useBatches(200);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");

  const shown = useMemo(() => {
    let list = data ?? [];
    if (show === "running") list = list.filter((b) => b.state === "running" || b.state === "paused");
    if (show === "failed") list = list.filter((b) => b.state === "failed");
    if (q.trim()) list = fuzzyRank(q.trim(), list, (b) => `${b.name} ${b.generator ?? ""}`, list.length);
    return list;
  }, [data, q, show]);

  const groups = useMemo(() => {
    const out: { day: string; items: BatchSummary[] }[] = [];
    for (const b of shown) {
      const day = q.trim() ? "Matches" : dayLabel(b.created_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(b);
      else out.push({ day, items: [b] });
    }
    return out;
  }, [shown, q]);

  return (
    <>
      <PageHeader title="Generations" count={data?.length} countLabel="batches" width="wide" />
      <PageBody width="wide">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-64 max-w-full">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input aria-label="Search batches" placeholder="Search batches" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <div role="radiogroup" aria-label="Show" className="inline-flex rounded-lg border border-line p-0.5">
            {(["all", "running", "failed"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={show === s}
                onClick={() => setShow(s)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs capitalize",
                  show === s ? "bg-raised text-neutral-100" : "text-muted hover:text-neutral-100",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {!isLoading && !shown.length ? (
          <EmptyState icon={History} title={data?.length ? "No batches match" : "No generations yet"} />
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.day}>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">{g.day}</h2>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] items-start gap-3">
                  {g.items.map((b) => (
                    <li key={b._id}>
                      <BatchCard b={b} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
