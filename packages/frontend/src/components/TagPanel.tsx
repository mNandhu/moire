import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, ExternalLink, Pencil, Tag as TagIcon, UserRound, X } from "lucide-react";
import { Badge } from "./ui/Badge";
import { Button, ButtonAnchor, ButtonLink } from "./ui/Button";
import { Skeleton } from "./ui/Skeleton";
import { Mosaic } from "./TagMosaic";
import { useTagSamples } from "../lib/tagSamples";
import { useToast } from "./Toasts";
import { errorText } from "../lib/api";
import { cn } from "../lib/cn";
import { useSignatures } from "../lib/rules";
import { DEFAULT_FILTERS, galleryHref, imageHref } from "../lib/imageFilter";
import { updateCharacter } from "../lib/imageMutations";
import { characterHref, tagHref } from "../lib/character";
import { CharacterAvatar } from "./CharacterAvatar";
import { useCharacterLookup } from "../lib/queries";
import { TAGS_KEY, useBoilerplate, useTagDescription, useTagDetail, useTagGroups } from "../lib/queries";
import { groupHref, groupLabel, groupOf } from "../lib/tagGroups";
import { danbooruWikiUrl, formatTag, onDanbooru } from "../lib/tags";
import { groupWorkflows, formatUsedRange } from "../lib/workflows";
import { useImageFeed } from "../hooks/useImageFeed";
import { usePinCover } from "../hooks/usePinCover";
import { PendingVeil, PinButton } from "./PinButton";
import { withBackgroundLocation } from "../lib/backgroundLocation";
import {
  galleryTag,
  monthLabel,
  chartMonths,
  recentMonths,
  renamableTags,
  tagWorkflows,
  type TagDetail,
  type TagSource,
} from "../lib/tagBrowse";

const PICK_PAGE = 30; // a 3-wide grid: ten rows a page
const RELATED = 12;


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
  const characterOf = useCharacterLookup();
  const character = detail?.category === "character" ? characterOf.get(tag) : undefined;
  const isBoilerplate = useBoilerplate();
  const description = useTagDescription(tag);
  const { data: groups } = useTagGroups();
  const group = groupOf(groups, tag);
  const { data: signatures } = useSignatures();
  const families = useMemo(() => groupWorkflows(signatures ?? []), [signatures]);

  const workflows = useMemo(
    () => (detail ? tagWorkflows(detail.workflows, families).slice(0, 5) : []),
    [detail, families],
  );
  const related = useMemo(
    () => (detail?.related ?? []).filter((r) => !isBoilerplate(r.tag)).slice(0, RELATED),
    [detail, isBoilerplate],
  );
  // The tag's mosaic, pinned cover first. Under TAGS_KEY, so pinning a new
  // cover below refreshes it.
  const sampleId = galleryTag(tag, source);
  const { data: samples } = useTagSamples(sampleId);
  const share = (n: number) => `${Math.round((n / (detail?.count || 1)) * 100)}%`;
  const qc = useQueryClient();
  const { push } = useToast();
  const markCharacter = async () => {
    try {
      await updateCharacter(tag, { kind: "character" });
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
    } catch (e) {
      push(`Couldn't mark it as a character: ${errorText(e)}`, "error");
    }
  };

  return (
    <aside
      aria-label={`Tag ${formatTag(tag)}`}
      className="rounded-xl border border-white/5 bg-surface shadow-panel p-4 space-y-5"
    >
      <div className="flex items-start gap-2">
        {character && (
          <Link to={characterHref(character.tag)} aria-label="Character page" className="shrink-0">
            <CharacterAvatar
              src={character.thumb_url}
              face={character.face}
              focus={character.focus}
              aspect={character.aspect}
              className="h-16 w-16 ring-1 ring-line hover:ring-brand-300"
              style={character.color ? { boxShadow: `0 0 0 2px ${character.color}` } : undefined}
            />
          </Link>
        )}
        <div className={cn("min-w-0 flex-1", character && "self-center")}>
          <h2 className="text-lg font-semibold leading-tight break-words flex items-center gap-2 flex-wrap">
            {formatTag(tag)}
            {detail?.category === "character" && <Badge className="text-2xs">Character</Badge>}
            {group && (
              <Link
                to={groupHref(group)}
                title={`Every tag in ${groupLabel(group)}`}
                className="rounded-md border border-line px-1.5 py-0.5 text-2xs font-normal text-muted hover:border-line-strong hover:text-neutral-100"
              >
                {groupLabel(group)}
              </Link>
            )}
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

      {description && <p className="text-sm leading-snug text-neutral-200">{description}</p>}

      {/* A character's avatar heads the panel; a tag shows a collage. */}
      {detail?.category !== "character" && (
        <Link to={tagHref(tag)} title="Open the tag's page" className="block rounded-lg overflow-hidden hover:opacity-90">
          <Mosaic samples={samples} cover={detail?.thumb_url ?? null} focus={detail?.focus} focusImage={detail?.cover_image_id} className="aspect-[16/10]" />
        </Link>
      )}

      <div className="flex flex-wrap gap-2">
        <ButtonLink size="sm" variant="primary" to={galleryHref({ tags: [galleryTag(tag, source)] })}>
          <ExternalLink size={14} /> Open in gallery
        </ButtonLink>
        {detail?.category === "character" ? (
          <ButtonLink size="sm" to={characterHref(tag)}>
            <UserRound size={14} /> Character page
          </ButtonLink>
        ) : (
          detail && (
            <>
            <ButtonLink size="sm" to={tagHref(tag)} title="Its images, cover and what it was made with">
              <TagIcon size={14} /> Tag page
            </ButtonLink>
            <Button size="sm" onClick={() => void markCharacter()} title="Give this tag a character page">
              <UserRound size={14} /> Mark as character
            </Button>
            </>
          )
        )}
        {detail &&
          renamableTags(detail).map((stored) => {
            const prompt = stored.startsWith("prompt:");
            const n = prompt ? detail.sources.prompt : detail.sources.manual;
            const both = renamableTags(detail).length > 1;
            return (
              <Button
                key={stored}
                size="sm"
                onClick={() => onRename(stored, n)}
                title={detail.sources.ai > 0 ? "The AI's tag keeps its name" : undefined}
              >
                <Pencil size={14} /> {both ? (prompt ? "Rename prompt tag" : "Rename my tag") : "Rename or merge"}
              </Button>
            );
          })}
        {detail && onDanbooru(detail.sources.ai, description) && (
          <ButtonAnchor size="sm" href={danbooruWikiUrl(tag)} title="Its page on Danbooru's wiki">
            <BookOpen size={14} /> Danbooru
          </ButtonAnchor>
        )}
      </div>

      {detail && (
        <TagImages tag={tag} source={source} count={detail.count} pinned={detail.thumb_image_id} />
      )}

      {!detail ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          <MonthChart first={detail.first_used} months={detail.months} />

          {(detail.loras.length > 0 || detail.embeddings.length > 0 || workflows.length > 0) && (
            <section className="space-y-2">
              <h3 className="text-2xs uppercase tracking-wider text-faint">Made with</h3>
              {detail.loras.length > 0 && (
                <ChipRow label="LoRA">
                  {detail.loras.map((l) => (
                    <Chip
                      key={l.name}
                      to={galleryHref({ lora: [l.name] })}
                      title={`${l.count.toLocaleString()} images`}
                      label={l.name}
                      share={share(l.count)}
                    />
                  ))}
                </ChipRow>
              )}
              {detail.embeddings.length > 0 && (
                <ChipRow label="Embedding">
                  {detail.embeddings.map((e) => (
                    <Chip
                      key={e.name}
                      to={galleryHref({ embedding: [e.name] })}
                      title={`${e.count.toLocaleString()} images`}
                      label={e.name}
                      share={share(e.count)}
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

        </>
      )}
    </aside>
  );
}

/** Images per month: up to two years, the latest month lit. */
export function MonthChart({
  first,
  months: counted,
  accent,
}: {
  first: number | null;
  months: TagDetail["months"];
  /** The bars' colour; the brand's by default. */
  accent?: string;
}) {
  const months = useMemo(() => recentMonths(counted, chartMonths(first)), [counted, first]);
  const peak = Math.max(1, ...months.map((m) => m.count));
  const charted = months.reduce((n, m) => n + m.count, 0);
  return (
    <section>
      <h3 className="text-2xs uppercase tracking-wider text-faint mb-2">
        {months.length} months · {charted.toLocaleString()} {charted === 1 ? "image" : "images"}
      </h3>
      <div className="flex items-end gap-1 h-14" role="img" aria-label={`Images per month over the last ${months.length} months`}>
        {months.map((m, i) => {
          const last = i === months.length - 1;
          return (
            <div
              key={m.month}
              title={`${monthLabel(m.month)}: ${m.count.toLocaleString()}`}
              className={cn(
                "flex-1 rounded-sm",
                !m.count ? "bg-line" : accent ? "" : last ? "bg-brand-300" : "bg-brand-600/70",
              )}
              style={{
                height: m.count ? `${Math.max(8, (m.count / peak) * 100)}%` : "2px",
                ...(m.count && accent ? { background: accent, opacity: last ? 1 : 0.7 } : {}),
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-2xs text-faint mt-1">
        <span>{monthLabel(months[0].month)}</span>
        <span>{monthLabel(months[months.length - 1].month)}</span>
      </div>
    </section>
  );
}

export function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 items-start">
      <span className="text-xs text-faint leading-6">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function Chip({ to, title, label, share }: { to: string; title: string; label: string; share: string }) {
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

/**
 * The tag's own images, newest first. Clicking one opens it in the viewer
 * over the Tags page, paging through this tag's images; the pin on hover
 * makes it the tag's cover.
 */
export function TagImages({
  tag,
  source,
  count,
  pinned,
}: {
  tag: string;
  source: TagSource;
  count: number;
  pinned: string | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const filters = useMemo(
    () => ({ ...DEFAULT_FILTERS, tags: [galleryTag(tag, source)] }),
    [tag, source],
  );
  const { items, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } = useImageFeed(
    filters,
    PICK_PAGE,
  );

  const open = (id: string) =>
    navigate(imageHref(id, filters), {
      state: withBackgroundLocation(location),
    });
  const { pin, pending } = usePinCover("cover");

  return (
    <section>
      <h3 className="text-2xs uppercase tracking-wider text-faint mb-2">
        Images · {count.toLocaleString()}
      </h3>
      <div className="grid grid-cols-3 gap-1">
        {isLoading &&
          Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded" />)}
        {items.map((img) => {
          const on = img._id === pinned;
          return (
            <div key={img._id} className="group/img relative aspect-square rounded overflow-hidden bg-raised">
              <button
                type="button"
                onClick={() => open(img._id)}
                aria-label={`Open ${img.path}`}
                title={img.path}
                className="absolute inset-0 hover:opacity-90"
              >
                <img src={img.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />
              </button>
              {/* A sibling of the open button, not inside it. */}
              {pending === img._id && <PendingVeil />}
              <PinButton
                on={on}
                pending={pending === img._id}
                disabled={pending !== null}
                noun="cover"
                onClick={() => void pin(tag, img._id, { unpin: on })}
              />
            </div>
          );
        })}
      </div>
      {hasNextPage && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? "Loading…" : "More images"}
        </Button>
      )}
    </section>
  );
}
