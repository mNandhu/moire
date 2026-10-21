import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { History, ImageOff, Layers, Loader2, Search } from "lucide-react";
import { Badge, EmptyState, Input, PageBody, PageHeader } from "../components/ui";
import { batchLine, coverAspect, dayLabel, scrubIndex, stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { useBatches, type BatchSummary } from "../lib/generate";
import { cn } from "../lib/cn";
import { fuzzyRank } from "../lib/fuzzy";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type Show = "all" | "running" | "failed";

// Masonry: columns at least this wide, this far apart. The grid's rows are
// 1px, and each card spans as many as it is tall (measured), so cards of
// different shapes pack without gaps while staying in reading order.
const MIN_COL = 190;
const GAP = 12;

/** One card in the masonry grid, spanning its own measured height. */
function MasonryItem({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSpan(Math.ceil(el.getBoundingClientRect().height) + GAP);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <li style={span ? { gridRowEnd: `span ${span}` } : undefined}>
      <div ref={ref}>{children}</div>
    </li>
  );
}

function Masonry({ items }: { items: BatchSummary[] }) {
  return (
    <ul
      className="grid"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${MIN_COL}px, calc(50% - ${GAP / 2}px)), 1fr))`, gridAutoRows: 1, columnGap: GAP }}
    >
      {items.map((b) => (
        <MasonryItem key={b._id}>
          <BatchCard b={b} />
        </MasonryItem>
      ))}
    </ul>
  );
}

/**
 * A batch's cover at the batch's own shape: its first image, edge to edge.
 * Moving the pointer across it (or arrow keys on the card) flips through the
 * images, a strip per image, with a thin bar showing where you are.
 */
function Cover({ b, at, onAt, warm }: { b: BatchSummary; at: number; onAt: (i: number) => void; warm: boolean }) {
  const urls = b.thumbs;
  if (!urls.length) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-center text-xs text-faint">
        {b.state === "running" || b.state === "paused" || b.arriving > 0 ? (
          <Loader2 size={20} className="animate-spin" />
        ) : (
          <>
            <ImageOff size={18} />
            {b.images > 0 && "All rejected"}
          </>
        )}
      </div>
    );
  }
  const n = urls.length;
  return (
    <div
      className="absolute inset-0"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onAt(scrubIndex(e.clientX - r.left, r.width, n));
      }}
      onPointerLeave={() => onAt(0)}
    >
      {urls.map((url, i) =>
        // The rest load once the card is hovered or focused: until then
        // only the front image is seen.
        warm || i === at ? (
          <img
            key={i}
            src={url}
            alt=""
            loading="lazy"
            className={cn("absolute inset-0 h-full w-full object-cover", i !== at && "opacity-0")}
          />
        ) : null,
      )}
      {n > 1 && (
        <>
          <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-white">
            <Layers size={11} aria-hidden />
            {Math.max(b.kept, n)}
          </span>
          <div
            aria-hidden
            className="absolute bottom-2 left-1.5 right-12 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {urls.map((_, i) => (
              <span key={i} className={cn("h-0.5 flex-1 rounded-full", i === at ? "bg-white" : "bg-white/30")} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A batch with several images is a deck: the edges of the cards behind
 * show above it, one for two images, two for more. */
function DeckEdges({ n }: { n: number }) {
  if (n < 2) return null;
  return (
    <>
      {n > 2 && (
        <span aria-hidden className="absolute inset-x-[14%] top-0 h-3 rounded-t-lg border border-b-0 border-line bg-raised/50" />
      )}
      <span aria-hidden className="absolute inset-x-[7%] top-1 h-3 rounded-t-lg border border-b-0 border-line-strong bg-raised" />
    </>
  );
}

function BatchCard({ b }: { b: BatchSummary }) {
  const [at, setAt] = useState(0);
  const [warm, setWarm] = useState(false);
  const n = b.thumbs.length;
  return (
    <div className="relative pt-2">
      <DeckEdges n={n} />
      <Link
        to={`/generations/${b._id}`}
        aria-label={`${b.name}, ${batchLine(b)}`}
        onKeyDown={(e) => {
          if (n < 2 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
          e.preventDefault();
          setAt((i) => (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n);
        }}
        onBlur={() => setAt(0)}
        onFocus={() => setWarm(true)}
        onPointerEnter={() => setWarm(true)}
        className="group relative block overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong"
      >
        <div className="relative bg-canvas" style={{ aspectRatio: coverAspect(b.width, b.height) }}>
          <Cover b={b} at={Math.min(at, Math.max(0, n - 1))} onAt={setAt} warm={warm} />
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
    </div>
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
                <Masonry items={g.items} />
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
