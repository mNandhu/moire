import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, ExternalLink, Pencil, Tag as TagIcon, UserRound, X } from "lucide-react";
import { Badge } from "./ui/Badge";
import { Button, ButtonAnchor, ButtonLink } from "./ui/Button";
import { Skeleton } from "./ui/Skeleton";
import { Mosaic } from "./TagMosaic";
import { MadeWithChips } from "./tagstats/MadeWithChips";
import { MonthChart } from "./tagstats/MonthChart";
import { PinnableImageGrid } from "./tagstats/PinnableImageGrid";
import { useTagSamples } from "../lib/tagSamples";
import { useToast } from "./Toasts";
import { errorText } from "../lib/api";
import { cn } from "../lib/cn";
import { useSignatures } from "../lib/rules";
import { DEFAULT_FILTERS, galleryHref } from "../lib/imageFilter";
import { updateCharacter } from "../lib/imageMutations";
import { characterHref, tagHref } from "../lib/character";
import { CharacterAvatar } from "./CharacterAvatar";
import { useCharacterLookup } from "../lib/queries";
import { TAGS_KEY, useBoilerplate, useTagDescription, useTagDetail, useTagGroups } from "../lib/queries";
import { groupHref, groupLabel, groupOf } from "../lib/tagGroups";
import { danbooruWikiUrl, formatTag, onDanbooru } from "../lib/tags";
import { groupWorkflows, formatUsedRange } from "../lib/workflows";
import {
  galleryTag,
  renamableTags,
  tagWorkflows,
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
  const imageFilters = useMemo(() => ({ ...DEFAULT_FILTERS, tags: [sampleId] }), [sampleId]);
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
        <PinnableImageGrid
          filters={imageFilters}
          pinTag={tag}
          pinned={detail.thumb_image_id}
          noun="cover"
          count={detail.count}
          pageSize={PICK_PAGE}
          variant="panel"
        />
      )}

      {!detail ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          <MonthChart first={detail.first_used} months={detail.months} />

          <MadeWithChips
            loras={detail.loras}
            embeddings={detail.embeddings}
            workflows={workflows}
            total={detail.count}
            heading="h3"
          />

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
