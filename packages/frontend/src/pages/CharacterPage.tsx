import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Copy, ExternalLink, Pencil, Tag as TagIcon, UserRound, Wand2 } from "lucide-react";
import { PageHeader } from "../components/ui/PageHeader";
import { Button, ButtonAnchor, ButtonLink } from "../components/ui/Button";
import { ScoreMark } from "../components/ui/ScoreMark";
import { Skeleton } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/Toasts";
import { Chip, ChipRow, MonthChart } from "../components/TagPanel";
import { useCharacters } from "../components/ImageCharacters";
import { CharacterEditDialog } from "../components/CharacterEditDialog";
import { TagEditDialog } from "../components/TagEditDialog";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { CharacterOutfits } from "../components/generate/CharacterOutfits";
import { useComfyModels, useRecipe } from "../lib/generate";
import { loadDraft, saveDraft, withCharacter } from "../lib/generateForm";
import { cn } from "../lib/cn";
import { useAmbientTint } from "../lib/ambient";
import { fetchSignatures } from "../lib/gen";
import { DEFAULT_FILTERS, serializeFilters, type Filters } from "../lib/imageFilter";
import { useBoilerplate, useCharacterPage, useTagDescription, useTagDetail, useTagPlaces } from "../lib/queries";
import { danbooruWikiUrl, formatTag, onDanbooru, toPromptText } from "../lib/tags";
import { useChipBorderStyle } from "../hooks/useTagMarks";
import { tagWorkflows } from "../lib/tagBrowse";
import { formatUsedRange, groupWorkflows } from "../lib/workflows";
import { withBackgroundLocation } from "../lib/backgroundLocation";
import { useImageFeed } from "../hooks/useImageFeed";
import { usePinCover } from "../hooks/usePinCover";
import { PendingVeil, PinButton } from "../components/PinButton";
import {
  characterColours,
  characterFilters,
  characterHref,
  displayName,
  fewImagesNote,
  tagHref,
  type CharacterPage as Character,
} from "../lib/character";

const PAGE = 48;
const SIGNATURE = 16;
const RATING_ORDER = ["general", "sensitive", "questionable", "explicit"];

const galleryHref = (patch: Partial<Filters>) =>
  `/?${serializeFilters({ ...DEFAULT_FILTERS, ...patch })}`;

/** A character's page; any other tag's page leaves out what only a person has. */
const isCharacter = (c: Character) => !!c.made || c.category === "character";
const pageHref = (c: Character) => (isCharacter(c) ? characterHref : tagHref)(c.tag);

/**
 * One character: their images, their look, what they were made with and who
 * they appear with, lit in their own colours. Opened from a character's
 * avatar in the image view or from the Tags page panel; any of the
 * character's names leads here, and the page moves to the one it uses.
 *
 * Any other tag gets the same page at /tags/:tag (`route="tag"`): its cover,
 * images, what it was made with, framed in the same Edit dialog, without the
 * character's name, look, colour or recipe.
 */
export default function CharacterPage({ route = "character" }: { route?: "character" | "tag" }) {
  const { tag = "" } = useParams();
  const navigate = useNavigate();
  const { data: c, isError, isLoading } = useCharacterPage(tag);
  const [editing, setEditing] = useState(false);
  const person = c ? isCharacter(c) : route === "character";

  // A bare name (`furina`) answers with the full one, and a tag that is (or
  // isn't) a character belongs on the other route: show that in the URL.
  useEffect(() => {
    if (c && (c.tag !== tag || person !== (route === "character"))) navigate(pageHref(c), { replace: true });
  }, [c, tag, person, route, navigate]);

  const colours = useMemo(() => (c && person ? characterColours(c) : []), [c, person]);
  useAmbientTint(colours);

  const { name, series } = person ? displayName(c ?? { tag }) : { name: formatTag(c?.tag ?? tag), series: null };
  // A plain tag's page says which tag group it sits in (`headwear_tags` -> Headwear).
  const { data: places } = useTagPlaces(!person && c ? [c.tag] : []);
  const place = !person && c ? places?.names[c.tag] : undefined;
  const group = place?.group?.replace(/_tags$/, "").replace(/_/g, " ");
  const groupLine = group ? group.charAt(0).toUpperCase() + group.slice(1) : undefined;
  const description = useTagDescription(c?.tag);
  // How many images the tagger gave it: whether Danbooru has a page for it.
  const { data: detail } = useTagDetail(c && !c.made ? c.tag : null, "all");

  if (isError) {
    return (
      <>
        <PageHeader title={formatTag(tag)} width="wide" />
        <EmptyState
          icon={person ? UserRound : TagIcon}
          title={person ? "No images have this character" : "No images have this tag"}
          description="It may have been renamed, or its images quarantined."
          actions={<ButtonLink to="/tags">Back to Tags</ButtonLink>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={name}
        width="wide"
        actions={
          c && (
            <>
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </Button>
              {detail && onDanbooru(detail.sources.ai, description) && (
                <ButtonAnchor size="sm" href={danbooruWikiUrl(c.tag)} title="Its page on Danbooru's wiki">
                  <BookOpen size={14} /> Danbooru
                </ButtonAnchor>
              )}
              {!c.made && (
                <ButtonLink size="sm" variant="primary" to={`/?${serializeFilters(characterFilters(c.tag, c.aliases))}`}>
                  <ExternalLink size={14} /> Open in gallery
                </ButtonLink>
              )}
            </>
          )
        }
      />
      <div className="mx-auto max-w-screen-2xl px-4 md:px-6 py-6 space-y-8">
        {isLoading || !c ? (
          <div className="flex items-center gap-5">
            <Skeleton className="h-28 w-28 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-72" />
            </div>
          </div>
        ) : (
          <>
            <Profile c={c} accent={colours[0]} person={person} name={name} subtitle={series ?? groupLine} description={description} />
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="space-y-8 min-w-0">
                {c.best.length > 0 && <BestOf c={c} />}
                {person && <CharacterOutfits character={c.tag} name={displayName(c).name} />}
                {c.made ? <NoImagesYet c={c} /> : <Images c={c} person={person} />}
              </div>
              <Sidebar c={c} accent={colours[0]} onEdit={() => setEditing(true)} person={person} />
            </div>
            {editing &&
              (person ? (
                <CharacterEditDialog open onClose={() => setEditing(false)} c={c} />
              ) : (
                <TagEditDialog open onClose={() => setEditing(false)} c={c} />
              ))}
          </>
        )}
      </div>
    </>
  );
}

function Avatar({ c, size, accent }: { c: Character; size: string; accent?: string }) {
  return (
    <CharacterAvatar
      src={c.thumb_url}
      face={c.face}
      focus={c.focus}
      aspect={c.aspect}
      className={cn("ring-1 ring-line text-4xl", size)}
      style={accent ? { boxShadow: `0 0 0 2px ${accent}` } : undefined}
      letter={displayName(c).name}
    />
  );
}

/** The avatar beside the name (and series or tag group) and description, how
 * much of the library they're in, other names, their look (a character's only). */
function Profile({
  c,
  accent,
  person,
  name,
  subtitle,
  description,
}: {
  c: Character;
  accent?: string;
  person: boolean;
  name: string;
  subtitle?: string | null;
  description?: string;
}) {
  const chipBorderStyle = useChipBorderStyle();
  const isBoilerplate = useBoilerplate();
  const { push } = useToast();
  const look = useMemo(
    () => (person ? c.signature.filter((s) => !isBoilerplate(s.tag)).slice(0, SIGNATURE) : []),
    [c.signature, isBoilerplate, person],
  );
  const range = formatUsedRange(c.first_used, c.last_used);
  // The look is read from the images they're alone in when there are enough.
  const lookShare = (n: number) =>
    c.signature_images < c.count
      ? `On ${n.toLocaleString()} of the ${c.signature_images.toLocaleString()} images they're alone in`
      : `On ${n.toLocaleString()} of ${c.count.toLocaleString()} images`;
  const copyLook = async () => {
    try {
      await navigator.clipboard.writeText(toPromptText([c.tag, ...look.map((s) => s.tag)]));
      push("Copied the character and their look as prompt text", "success");
    } catch {
      push("Couldn't copy to the clipboard", "error");
    }
  };

  return (
    <section className="flex flex-col sm:flex-row gap-5 sm:items-center">
      <Avatar c={c} size="h-28 w-28" accent={accent} />
      <div className="min-w-0 space-y-3">
        <div>
          <h2 className="text-2xl font-semibold leading-tight break-words">{name}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          {description && <p className="mt-2 max-w-prose text-sm leading-snug text-neutral-200">{description}</p>}
        </div>
        <p className="text-sm text-muted tabular-nums">
          {c.count.toLocaleString()} {c.count === 1 ? "image" : "images"}
          {range && ` · ${range}`}
          {c.aliases.length > 0 && (
            <span className="text-faint"> · also tagged {c.aliases.map(formatTag).join(", ")}</span>
          )}
        </p>
        {look.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {look.map((s) => (
              <Link
                key={s.tag}
                to={galleryHref({ ...characterFilters(c.tag, []), tags: [`any:${c.tag}`, `any:${s.tag}`] })}
                title={
                  lookShare(s.count) +
                  // The gallery can't AND a look onto "any of these names".
                  (c.aliases.length ? `. Opens those tagged ${formatTag(c.tag)}.` : "")
                }
                style={chipBorderStyle(s.tag)}
                className="inline-flex items-center h-6 px-2 rounded-full bg-raised/80 border border-line text-xs text-neutral-200 hover:border-line-strong"
              >
                {formatTag(s.tag)}
              </Link>
            ))}
            <Button size="sm" variant="ghost" onClick={() => void copyLook()} title="Copy as prompt text">
              <Copy size={14} /> Copy look
            </Button>
          </div>
        )}
        {look.length > 0 && fewImagesNote(c.signature_images) && (
          <p className="text-xs text-faint">{fewImagesNote(c.signature_images)}</p>
        )}
      </div>
    </section>
  );
}

function useOpenImage(filters: Filters) {
  const navigate = useNavigate();
  const location = useLocation();
  return (id: string) =>
    navigate(`/image/${encodeURIComponent(id)}?${serializeFilters(filters)}`, {
      state: withBackgroundLocation(location),
    });
}

/** Their best-scored images; only shown once some are scored. */
function BestOf({ c }: { c: Character }) {
  const open = useOpenImage(characterFilters(c.tag, c.aliases));
  return (
    <section>
      <h2 className="text-2xs uppercase tracking-wider text-faint mb-2">
        Best of
        {c.scored.average !== null && ` · average ${c.scored.average.toFixed(1)}`}
      </h2>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {c.best.map((b) => (
          <button
            key={b.image_id}
            type="button"
            onClick={() => open(b.image_id)}
            title={`Score ${b.score}`}
            className="relative h-48 aspect-[3/4] shrink-0 rounded-lg overflow-hidden bg-raised hover:opacity-90"
          >
            <img src={b.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />
            <ScoreMark score={b.score} className="absolute left-2 bottom-1.5" />
          </button>
        ))}
      </div>
    </section>
  );
}

/** Every image of theirs, newest first; the pin makes one their avatar (a
 * tag's cover). */
function Images({ c, person }: { c: Character; person: boolean }) {
  const noun = person ? "avatar" : "cover";
  const { pin, pending } = usePinCover(noun);
  const filters = useMemo(() => characterFilters(c.tag, c.aliases), [c.tag, c.aliases]);
  const open = useOpenImage(filters);
  const { items, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } = useImageFeed(filters, PAGE);
  const pinned = c.thumb_image_id;

  return (
    <section>
      <h2 className="text-2xs uppercase tracking-wider text-faint mb-2">
        Images · {c.count.toLocaleString()}
      </h2>
      <div className="grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-6 gap-1.5">
        {isLoading &&
          Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded" />)}
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
              {pending === img._id && <PendingVeil />}
              <PinButton
                on={on}
                pending={pending === img._id}
                disabled={pending !== null}
                noun={noun}
                onClick={() => void pin(c.tag, img._id, { unpin: on })}
              />
            </div>
          );
        })}
      </div>
      {hasNextPage && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? "Loading…" : "More images"}
        </Button>
      )}
    </section>
  );
}

/** Open the composer with this character picked. */
function useGenerateWith() {
  const navigate = useNavigate();
  return (tag: string) => {
    saveDraft(withCharacter(loadDraft(), tag));
    navigate("/generate");
  };
}

/** Where a character made by hand will have images: a way to make some. */
function NoImagesYet({ c }: { c: Character }) {
  const generate = useGenerateWith();
  return (
    <section>
      <h2 className="text-2xs uppercase tracking-wider text-faint mb-2">Images · 0</h2>
      <div className="grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-6 gap-1.5">
        <button
          type="button"
          onClick={() => generate(c.tag)}
          className="col-span-2 flex aspect-[2/1] flex-col items-center justify-center gap-2 rounded border border-dashed border-line-strong text-sm text-neutral-200 hover:border-brand-500 hover:text-white"
        >
          <Wand2 size={20} />
          Generate
        </button>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="aspect-square rounded border border-dashed border-line/60" aria-hidden />
        ))}
      </div>
    </section>
  );
}

/** What the Generate composer writes for them, edited in the Edit dialog. */
function Recipe({ c, onEdit }: { c: Character; onEdit: () => void }) {
  const chipBorderStyle = useChipBorderStyle();
  const generate = useGenerateWith();
  const { data: recipe } = useRecipe(c.tag);
  const { data: models } = useComfyModels();
  if (!recipe) return null;
  const kept = recipe.identity.filter((x) => !x.dropped);
  const lora = recipe.lora;
  const missing = !!lora && !lora.file && !!models;
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xs uppercase tracking-wider text-faint" title="What Generate writes for this character">
          Recipe
        </h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit recipe" title="Edit recipe">
            <Pencil size={13} />
          </Button>
          <Button size="sm" onClick={() => generate(c.tag)}>
            <Wand2 size={13} /> Generate
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {kept.length ? (
          kept.map((x) => (
            <span
              key={x.tag}
              style={chipBorderStyle(x.tag)}
              className="inline-flex h-6 items-center rounded-full border border-line bg-raised/80 px-2 text-xs text-neutral-200"
            >
              {formatTag(x.tag)}
            </span>
          ))
        ) : (
          <span className="text-xs text-faint">No identity tags</span>
        )}
      </div>
      {kept.length > 0 && fewImagesNote(recipe.identity_images) && (
        <p className="text-xs text-faint">{fewImagesNote(recipe.identity_images)}</p>
      )}
      {lora && (
        <p className={cn("font-mono text-xs", missing ? "text-amber-200 line-through" : "text-muted")} title={missing ? "Not installed in ComfyUI" : undefined}>
          {lora.stem} {lora.strength.toFixed(2)}
        </p>
      )}
    </section>
  );
}

/** Who they appear with (for a tag: which characters carry it), what they were made with, when, and how rated. */
function Sidebar({ c, accent, onEdit, person }: { c: Character; accent?: string; onEdit: () => void; person: boolean }) {
  const { data: everyone } = useCharacters();
  const { data: signatures } = useQuery({
    queryKey: ["rules-signatures"],
    queryFn: fetchSignatures,
    staleTime: 60_000,
  });
  const workflows = useMemo(
    () => tagWorkflows(c.workflows, groupWorkflows(signatures ?? [])).slice(0, 5),
    [c.workflows, signatures],
  );
  const byTag = useMemo(() => new Map((everyone ?? []).map((e) => [e.tag, e])), [everyone]);
  const share = (n: number) => `${Math.round((n / (c.count || 1)) * 100)}%`;
  const ratings = RATING_ORDER.filter((r) => c.ratings[r]);

  return (
    <aside className="space-y-6">
      {person && <Recipe c={c} onEdit={onEdit} />}
      {c.with.length > 0 && (
        <section>
          <h2 className="text-2xs uppercase tracking-wider text-faint mb-2">
            {person ? "Appears with" : "Characters with this tag"}
          </h2>
          <div className="flex flex-wrap gap-x-3 gap-y-3">
            {c.with.map((w) => {
              const other = byTag.get(w.tag);
              return (
                <Link
                  key={w.tag}
                  to={characterHref(w.tag)}
                  title={`${w.count.toLocaleString()} ${w.count === 1 ? "image" : "images"} ${person ? "together" : "with this tag"}`}
                  className="group flex w-16 flex-col items-center gap-1 text-center"
                >
                  <CharacterAvatar
                    src={other?.thumb_url}
                    face={other?.face ?? null}
                    focus={other?.focus ?? null}
                    aspect={other?.aspect ?? null}
                    className="h-12 w-12 ring-1 ring-line group-hover:ring-brand-300"
                  />
                  <span className="w-full text-2xs leading-tight text-neutral-200 line-clamp-2 break-words">
                    {displayName({ tag: w.tag, name: other?.name }).name}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {person && (c.loras.length > 0 || c.embeddings.length > 0 || workflows.length > 0) && (
        <section className="space-y-2">
          <h2 className="text-2xs uppercase tracking-wider text-faint">Made with</h2>
          {c.loras.length > 0 && (
            <ChipRow label="LoRA">
              {c.loras.map((l) => (
                <Chip
                  key={l.name}
                  to={galleryHref({ ...characterFilters(c.tag, c.aliases), lora: [l.name] })}
                  title={[
                    `${l.count.toLocaleString()} images`,
                    l.strength !== null && `usually at ${l.strength}`,
                    l.score !== null && `average score ${l.score.toFixed(1)}`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  label={l.name}
                  share={[share(l.count), l.strength !== null && `@${l.strength}`].filter(Boolean).join(" ")}
                />
              ))}
            </ChipRow>
          )}
          {c.embeddings.length > 0 && (
            <ChipRow label="Embedding">
              {c.embeddings.map((e) => (
                <Chip
                  key={e.name}
                  to={galleryHref({ ...characterFilters(c.tag, c.aliases), embedding: [e.name] })}
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
                  to={galleryHref({ ...characterFilters(c.tag, c.aliases), ...w.filter })}
                  title={`${w.count.toLocaleString()} images`}
                  label={w.name}
                  share={share(w.count)}
                />
              ))}
            </ChipRow>
          )}
        </section>
      )}

      <MonthChart first={c.first_used} months={c.months} accent={accent} />

      {ratings.length > 0 && (
        <section>
          <h2 className="text-2xs uppercase tracking-wider text-faint mb-2">Ratings</h2>
          <p className="text-xs text-muted tabular-nums">
            {ratings.map((r) => `${r[0].toUpperCase()}${r.slice(1)} ${c.ratings[r].toLocaleString()}`).join(" · ")}
          </p>
        </section>
      )}
    </aside>
  );
}
