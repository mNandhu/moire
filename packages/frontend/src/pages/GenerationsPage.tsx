import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { History, Search } from "lucide-react";
import { Badge, EmptyState, Input, PageBody, PageHeader } from "../components/ui";
import { batchLine, dayLabel, stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { thumbUrl, useBatches, type BatchSummary } from "../lib/generate";
import { cn } from "../lib/cn";
import { fuzzyRank } from "../lib/fuzzy";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type Show = "all" | "running" | "failed";
const STRIP_H = 56;

/** Thumbnails at the batch's own ratio, cropped to the row. */
function Strip({ b }: { b: BatchSummary }) {
  const ratio = b.width && b.height ? b.width / b.height : 2 / 3;
  const w = Math.round(STRIP_H * ratio);
  if (!b.thumbs.length) {
    return (
      <div className="w-64 shrink-0">
        <div className="rounded-md bg-raised" style={{ width: w, height: STRIP_H }} />
      </div>
    );
  }
  return (
    <div className="flex w-64 shrink-0 gap-1 overflow-hidden">
      {b.thumbs.slice(0, 6).map((id) => (
        <img
          key={id}
          src={thumbUrl(id)}
          alt=""
          loading="lazy"
          className="shrink-0 rounded-md object-cover bg-raised"
          style={{ width: w, height: STRIP_H }}
        />
      ))}
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
      <PageHeader title="Generations" count={data?.length} countLabel="batches" />
      <PageBody>
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
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {g.items.map((b) => (
                    <li key={b._id}>
                      <Link to={`/generations/${b._id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-raised/60">
                        <Strip b={b} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-neutral-100">{b.name}</div>
                          <div className="truncate text-xs text-faint">
                            {batchLine(b)} · {b.generator ?? "Generator"} · {whenLabel(b.created_at)}
                          </div>
                        </div>
                        <Badge tone={stateTone(b.state)}>{STATE_LABEL[b.state]}</Badge>
                      </Link>
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
