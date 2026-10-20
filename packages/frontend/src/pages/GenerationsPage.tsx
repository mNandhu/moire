import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { History, ImageOff, Loader2, Search } from "lucide-react";
import { Badge, EmptyState, Input, PageBody, PageHeader } from "../components/ui";
import { batchLine, dayLabel, stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { thumbUrl, useBatches, type BatchSummary } from "../lib/generate";
import { cn } from "../lib/cn";
import { fuzzyRank } from "../lib/fuzzy";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type Show = "all" | "running" | "failed";

/**
 * A batch's images as one cover: one fills it, two sit side by side, more
 * make a mosaic with the rest counted on the last tile.
 */
function Cover({ b }: { b: BatchSummary }) {
  const ids = b.thumbs.slice(0, 4);
  const more = b.kept - ids.length;
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
  const tile = (id: string, i: number, className?: string) => (
    <div key={id} className={cn("relative overflow-hidden bg-raised", className)}>
      <img src={thumbUrl(id)} alt="" loading="lazy" className="h-full w-full object-cover" />
      {i === ids.length - 1 && more > 0 && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-sm font-medium text-white">+{more}</span>
      )}
    </div>
  );
  if (ids.length === 1) return tile(ids[0], 0, "h-full");
  if (ids.length === 2) return <div className="grid h-full grid-cols-2 gap-0.5">{ids.map((id, i) => tile(id, i))}</div>;
  if (ids.length === 3) {
    return (
      <div className="grid h-full grid-cols-2 grid-rows-2 gap-0.5">
        {tile(ids[0], 0, "row-span-2")}
        {tile(ids[1], 1)}
        {tile(ids[2], 2)}
      </div>
    );
  }
  return <div className="grid h-full grid-cols-2 grid-rows-2 gap-0.5">{ids.map((id, i) => tile(id, i))}</div>;
}

function BatchCard({ b }: { b: BatchSummary }) {
  return (
    <Link
      to={`/generations/${b._id}`}
      className="group block overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong"
    >
      <div className="relative aspect-[3/4] bg-canvas">
        <Cover b={b} />
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
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
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
