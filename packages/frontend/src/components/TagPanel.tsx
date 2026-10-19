import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, Pin, X } from "lucide-react";
import { Badge } from "./ui/Badge";
import { Button, ButtonLink } from "./ui/Button";
import { Skeleton } from "./ui/Skeleton";
import { useToast } from "./Toasts";
import { cn } from "../lib/cn";
import { fetchSignatures } from "../lib/gen";
import { DEFAULT_FILTERS, serializeFilters, type Filters } from "../lib/imageFilter";
import { clearTagThumbnail, setTagThumbnail } from "../lib/imageMutations";
import { TAGS_KEY, useBoilerplate, useTagDetail } from "../lib/queries";
import { formatTag } from "../lib/tags";
import { groupWorkflows, formatUsedRange } from "../lib/workflows";
import { useImageFeed } from "../hooks/useImageFeed";
import {
  foundBy,
  galleryTag,
  monthLabel,
  chartMonths,
  recentMonths,
  renamableTags,
  tagWorkflows,
  type TagSource,
} from "../lib/tagBrowse";

const PICK_PAGE = 30;
const RELATED = 12;

const galleryHref = (patch: Partial<Filters>) =>
  `/?${serializeFilters({ ...DEFAULT_FILTERS, ...patch })}`;

/**
 * One tag in detail, beside the Tags page list: when it was used, what it
 * was made with, what it appears with, and its cover, picked from its own
 * images. Counts follow the page's Source filter.
 */
export function TagPanel({
  tag,
  source,
  onClose,
  onSelect,
  onRename,
}: {
  tag: string;
  source: TagSource;
  onClose: () => void;
  /** Open another tag (a related one) in this panel. */
  onSelect: (tag: string) => void;
  /** Rename one stored tag (`prompt:x` / `manual:x`). */
  onRename: (stored: string, count: number) => void;
}) {
  const { data: detail, isError } = useTagDetail(tag, source);
  const isBoilerplate = useBoilerplate();
  const { data: signatures } = useQuery({
    queryKey: ["rules-signatures"],
    queryFn: fetchSignatures,
    staleTime: 60_000,
  });
  const families = useMemo(() => groupWorkflows(signatures ?? []), [signatures]);

  const months = useMemo(
    () => recentMonths(detail?.months ?? [], chartMonths(detail?.first_used ?? null)),
    [detail],
  );
  const peak = Math.max(1, ...months.map((m) => m.count));
  const charted = months.reduce((n, m) => n + m.count, 0);
  const workflows = useMemo(
    () => (detail ? tagWorkflows(detail.workflows, families).slice(0, 5) : []),
    [detail, families],
  );
  const related = useMemo(
    () => (detail?.related ?? []).filter((r) => !isBoilerplate(r.tag)).slice(0, RELATED),
    [detail, isBoilerplate],
  );
  const share = (n: number) => `${Math.round((n / (detail?.count || 1)) * 100)}%`;

  return (
    <aside
      aria-label={`Tag ${formatTag(tag)}`}
      className="rounded-xl border border-white/5 bg-surface shadow-panel p-4 space-y-5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight break-words flex items-center gap-2 flex-wrap">
            {formatTag(tag)}
            {detail?.category === "character" && <Badge className="text-2xs">Character</Badge>}
          </h2>
          <p className="text-xs text-muted mt-1 tabular-nums">
            {detail ? (
              <>
                {detail.count.toLocaleString()} {detail.count === 1 ? "image" : "images"}
                {formatUsedRange(detail.first_used, detail.last_used) &&
                  ` · ${formatUsedRange(detail.first_used, detail.last_used)}`}
              </>
            ) : isError ? (
              "Couldn't load this tag."
            ) : (
              " "
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tag details"
          title="Close (Esc)"
          className="h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center text-muted hover:text-white hover:bg-raised"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <ButtonLink size="sm" variant="primary" to={galleryHref({ tags: [galleryTag(tag, source)] })}>
          <ExternalLink size={14} /> Open in gallery
        </ButtonLink>
        {detail &&
          renamableTags(detail).map((stored) => {
            const prompt = stored.startsWith("prompt:");
            const n = prompt ? detail.sources.prompt : detail.sources.manual;
            const both = renamableTags(detail).length > 1;
            return (
              <Button key={stored} size="sm" onClick={() => onRename(stored, n)}>
                <Pencil size={14} /> {both ? (prompt ? "Rename prompt tag" : "Rename my tag") : "Rename or merge"}
              </Button>
            );
          })}
      </div>

      {!detail ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          <section>
            <h3 className="text-2xs uppercase tracking-wider text-faint mb-2">
              {months.length} months · {charted.toLocaleString()} {charted === 1 ? "image" : "images"}
            </h3>
            <div className="flex items-end gap-1 h-14" role="img" aria-label={`Images per month over the last ${months.length} months`}>
              {months.map((m, i) => (
                <div
                  key={m.month}
                  title={`${monthLabel(m.month)}: ${m.count.toLocaleString()}`}
                  className={cn(
                    "flex-1 rounded-sm",
                    m.count ? (i === months.length - 1 ? "bg-brand-300" : "bg-brand-600/70") : "bg-line",
                  )}
                  style={{ height: m.count ? `${Math.max(8, (m.count / peak) * 100)}%` : "2px" }}
                />
              ))}
            </div>
            <div className="flex justify-between text-2xs text-faint mt-1">
              <span>{monthLabel(months[0].month)}</span>
              <span>{monthLabel(months[months.length - 1].month)}</span>
            </div>
          </section>

          {(detail.loras.length > 0 || workflows.length > 0) && (
            <section className="space-y-2">
              <h3 className="text-2xs uppercase tracking-wider text-faint">Made with</h3>
              {detail.loras.length > 0 && (
                <ChipRow label="LoRA">
                  {detail.loras.map((l) => (
                    <Chip
                      key={l.name}
                      to={galleryHref({ lora: l.name })}
                      title={`${l.count.toLocaleString()} images`}
                      label={l.name}
                      share={share(l.count)}
                    />
                  ))}
                </ChipRow>
              )}
              {workflows.length > 0 && (
                <ChipRow label="Workflow">
                  {workflows.map((w) => (
                    <Chip
                      key={JSON.stringify(w.filter)}
                      to={galleryHref(w.filter)}
                      title={`${w.count.toLocaleString()} images`}
                      label={w.name}
                      share={share(w.count)}
                    />
                  ))}
                </ChipRow>
              )}
            </section>
          )}

          {related.length > 0 && (
            <section>
              <h3 className="text-2xs uppercase tracking-wider text-faint mb-2">Often with</h3>
              <div className="flex flex-wrap gap-1.5">
                {related.map((r) => (
                  <button
                    key={r.tag}
                    type="button"
                    onClick={() => onSelect(r.tag)}
                    title={`${r.count.toLocaleString()} images have both`}
                    className="inline-flex items-baseline gap-1 h-6 px-2 rounded-full bg-raised border border-line text-xs text-neutral-200 hover:border-line-strong"
                  >
                    {formatTag(r.tag)}
                    <em className="not-italic text-2xs text-faint">{share(r.count)}</em>
                  </button>
                ))}
              </div>
            </section>
          )}

          <CoverPicker tag={tag} source={source} pinned={detail.thumb_image_id} />

          <p className="text-2xs text-faint">
            Found by {foundBy(detail.sources)}.
            {detail.sources.ai > 0 && renamableTags(detail).length > 0 && " AI tags keep their name when renamed."}
          </p>
        </>
      )}
    </aside>
  );
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 items-start">
      <span className="text-xs text-faint leading-6">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ to, title, label, share }: { to: string; title: string; label: string; share: string }) {
  return (
    <Link
      to={to}
      title={`${label}: ${title}`}
      className="inline-flex items-baseline gap-1.5 max-w-full h-6 px-2 rounded-full bg-raised border border-line text-xs text-neutral-200 hover:border-line-strong"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-2xs text-faint tabular-nums">{share}</span>
    </Link>
  );
}

/** The tag's own images, newest first; clicking one pins it as the cover. */
function CoverPicker({
  tag,
  source,
  pinned,
}: {
  tag: string;
  source: TagSource;
  pinned: string | null;
}) {
  const qc = useQueryClient();
  const { push } = useToast();
  const filters = useMemo(
    () => ({ ...DEFAULT_FILTERS, tags: [galleryTag(tag, source)] }),
    [tag, source],
  );
  const { items, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } = useImageFeed(
    filters,
    PICK_PAGE,
  );

  const pin = async (id: string) => {
    try {
      await setTagThumbnail(tag, id);
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
    } catch (e) {
      push(`Couldn't set the cover: ${String(e)}`, "error");
    }
  };
  const unpin = async () => {
    try {
      await clearTagThumbnail(tag);
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
    } catch (e) {
      push(`Couldn't clear the cover: ${String(e)}`, "error");
    }
  };

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-2xs uppercase tracking-wider text-faint">Cover</h3>
        {pinned && (
          <button type="button" onClick={() => void unpin()} className="text-2xs text-muted hover:text-white">
            Let Moiré pick
          </button>
        )}
      </div>
      <div className="grid grid-cols-5 gap-1">
        {isLoading &&
          Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded" />)}
        {items.map((img) => {
          const on = img._id === pinned;
          return (
            <button
              key={img._id}
              type="button"
              onClick={() => void pin(img._id)}
              aria-pressed={on}
              aria-label={on ? "Pinned cover" : "Use as cover"}
              title={on ? "Pinned cover" : "Use as cover"}
              className={cn(
                "relative aspect-square rounded overflow-hidden bg-raised",
                on ? "ring-2 ring-brand-300 ring-offset-1 ring-offset-surface" : "hover:opacity-80",
              )}
            >
              <img src={img.thumb_url} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
              {on && (
                <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-black/70 inline-flex items-center justify-center text-white">
                  <Pin size={9} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-2xs text-faint mt-2">
        {pinned ? "Pinned. Click another image to change it." : "Click an image to pin it as the cover."}
      </p>
      {hasNextPage && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? "Loading…" : "More images"}
        </Button>
      )}
    </section>
  );
}
