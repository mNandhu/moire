import { ExternalLink } from "lucide-react";
import { smallThumb } from "../../../lib/media";
import { tagHref } from "../../../lib/character";
import type { Placed } from "../../../lib/promptBoard";
import { useTagDescription } from "../../../lib/queries";
import { formatWeight } from "../../../lib/tags";
import { groupHref } from "../../../lib/tagGroups";
import { useTagSamples } from "../../../lib/tagSamples";

const pretty = (g?: string) => (g ? g.replace(/_tags$/, "").replace(/_/g, " ") : "");
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Hover card: a few library images with the tag, how common it is, where
 * it's filed, and the tag an alias stands for. */
export function TagPreview({ term, count, swap }: { term: Placed; count: number | undefined; swap?: { label: string; run: () => void } }) {
  const p = term.place;
  const tag = p?.alias_of ?? term.name;
  const tagged = term.kind === "tag";
  const description = useTagDescription(tagged ? tag : null);
  // The Tags page's pick: shuffled, one image per batch while it can.
  const { data, isPending } = useTagSamples(`any:${tag}`, 4, { enabled: tagged, staleTime: 60_000 });
  return (
    <div className="w-[17rem] space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-neutral-50">{term.written}</span>
        {term.weight != null && <span className="text-xs text-amber-300">{formatWeight(term.weight)}</span>}
        {tagged && (
          <span className="ml-auto text-xs text-faint">
            {count ? `${count.toLocaleString()} ${count === 1 ? "image" : "images"}` : "Not in library"}
          </span>
        )}
        {tagged && count ? (
          <a
            href={tagHref(tag)}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open the ${term.written} tag page`}
            title="Open the tag page"
            className="-mr-0.5 shrink-0 rounded p-0.5 text-faint hover:bg-white/10 hover:text-neutral-100"
          >
            <ExternalLink size={13} />
          </a>
        ) : null}
      </div>
      {description && <p className="text-xs leading-snug text-neutral-200">{description}</p>}
      {p?.alias_of && (
        <div className="flex items-center gap-2 text-xs text-amber-200">
          Alias of {p.alias_of.replace(/_/g, " ")}
          {swap && (
            <button type="button" onClick={swap.run} className="ml-auto rounded-md bg-amber-500/15 px-2 py-0.5 text-amber-100 hover:bg-amber-500/25">
              {swap.label}
            </button>
          )}
        </div>
      )}
      {tagged && (
        <div className="grid h-[92px] grid-cols-4 gap-1">
          {isPending
            ? Array.from({ length: 4 }, (_, i) => <div key={i} className="animate-pulse rounded bg-surface" />)
            : (data ?? []).map((img) => <img key={img._id} src={smallThumb(img.thumb_url)} alt="" className="h-full w-full rounded object-cover" />)}
          {!isPending && !data?.length && (
            <div className="col-span-4 grid place-items-center rounded border border-dashed border-line text-xs text-faint">No images with it yet</div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-faint">
        {term.box === "unknown" ? (
          <span className="text-red-300">Not a Danbooru tag</span>
        ) : term.box === "library" ? (
          <span className="text-amber-300">Not a Danbooru tag, used in your library</span>
        ) : (
          <>
            {p?.group && (
              <a href={groupHref(p.group)} target="_blank" rel="noreferrer" className="hover:text-neutral-100 hover:underline">
                {pretty(p.group)}
              </a>
            )}
            {p?.posts != null && <span>{compact(p.posts)} on Danbooru</span>}
          </>
        )}
      </div>
    </div>
  );
}
