import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Dices, Gem, History, Layers, Shuffle, Sparkles, Star, Workflow } from "lucide-react";
import { PageHeader, PageBody } from "@/app/components/PageHeader";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { DEFAULT_FILTERS, galleryHref, type Filters } from "@/features/images/lib/imageFilter";
import { imageModelsQuery } from "@/features/images/lib/queries";
import { useLucky } from "@/features/images/hooks/useLucky";
import { useTagBrowse } from "@/features/tags/lib/queries";
import { formatTag } from "@/features/tags/lib/tags";
import { galleryTag } from "@/features/tags/lib/tagBrowse";
import { useCharacters } from "@/features/characters/lib/queries";
import { characterFilters as filtersOf, focusPosition } from "@/features/characters/lib/character";
import { DiscoverSection, ImageStrip, SHELF } from "@/features/discover/components/DiscoverSection";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { STRIP_SIZE, useRandomImages } from "@/features/discover/lib/queries";
import { bannerPicture, fillUp, heldPick, MIN_SHELF, pickOne, rareTags, type Held } from "@/features/discover/lib/discover";
import { useSignatures } from "@/features/metadata/lib/rules";
import { groupWorkflows } from "@/features/metadata/lib/workflows";
import { useQuery } from "@tanstack/react-query";

const RARE_SHOWN = 12;
const UNSCORED: Filters = { ...DEFAULT_FILTERS, unscored: true };
const TOP_RATED: Filters = { ...DEFAULT_FILTERS, minScore: 4 };
// Not opened in a month (or ever, since views were recorded); favorites first.
const UNSEEN: Filters = { ...DEFAULT_FILTERS, unviewedDays: 30 };
const UNSEEN_FAVORITES: Filters = { ...UNSEEN, minScore: 4 };
const general = <T extends { category: string; count: number }>(tags: T[]) =>
  tags.filter((t) => t.category === "general" && t.count >= 2);
const shuffled = (f: Filters) => galleryHref({ ...f, sort: "shuffle" });
// Each shelf's image count at its last deal, by filter (`key`). A filter too
// small to show then is too small now: it stays hidden while it loads,
// rather than holding placeholders and vanishing.
const lastCount = new Map<string, number>();
/** A shelf shows when it has enough to look like one; while it loads, when
 * its filter had enough last time (or there was no last time). */
function shown(key: string, q: { isPending: boolean; data?: unknown[] }): boolean {
  if (q.data) lastCount.set(key, q.data.length);
  if (q.isPending) return (lastCount.get(key) ?? MIN_SHELF) >= MIN_SHELF;
  return (q.data?.length ?? 0) >= MIN_SHELF;
}
/** Placeholders for a loading shelf: what is known to come, at most a shelf. */
const expected = (known: number | undefined) => Math.min(STRIP_SIZE, known ?? STRIP_SIZE);

// Kept while the app is open, so coming back shows the same picks and the
// next Shuffle is a deal never seen (each deal's images are cached).
let lastDeal = 0;
const held = new Map<string, Held<unknown>>();

/**
 * Discover: random corners of the library. One character, images not seen
 * lately (favorites first), top rated and unscored ones, rare tags, one
 * workflow and one model; Shuffle deals them all again.
 */
export default function DiscoverPage() {
  const [deal, setDeal] = useState(() => lastDeal);
  useEffect(() => {
    lastDeal = deal;
  }, [deal]);
  const { feelLucky, busy } = useLucky(DEFAULT_FILTERS);

  const unscored = useRandomImages(UNSCORED, deal);
  const top = useRandomImages(TOP_RATED, deal);
  const unseenFavorites = useRandomImages(UNSEEN_FAVORITES, deal);
  const unseenRest = useRandomImages(UNSEEN, deal);
  // Favorites that fail to load are none: the rest still fill the shelf.
  const favorites = unseenFavorites.isError ? [] : unseenFavorites.data;
  const unseen = {
    isPending: (unseenFavorites.isPending && !unseenFavorites.isError) || unseenRest.isPending,
    data: favorites && unseenRest.data ? fillUp(favorites, unseenRest.data, STRIP_SIZE) : undefined,
  };

  // AI tags name what is in the picture; until enough images are AI-tagged,
  // every source's tags (prompt words too) fill in.
  const aiTags = useTagBrowse("ai", { staleTime: 60_000 });
  const fewAiTags = !!aiTags.data && general(aiTags.data).length < RARE_SHOWN;
  const allTags = useTagBrowse("all", { staleTime: 60_000, enabled: fewAiTags });
  const tags = fewAiTags ? allTags : aiTags;
  const tagsFailed = aiTags.isError || (fewAiTags && allTags.isError);
  const rarePick = heldPick(held, "rare", deal, tags.data, (data) => ({
    tags: rareTags(general(data), RARE_SHOWN),
    source: fewAiTags ? ("all" as const) : ("ai" as const),
  }));
  const rare = rarePick?.tags ?? [];

  const characters = useCharacters();
  const character = heldPick(held, "character", deal, characters.data, (data) =>
    // The banner shows their avatar image.
    pickOne(data.filter((c) => c.count > 0 && c.thumb_url)),
  );
  // Every name the character goes by, as their page does.
  const characterFilters = useMemo<Filters | null>(
    () => (character ? filtersOf(character.tag, character.aliases) : null),
    [character],
  );
  const characterImages = useRandomImages(characterFilters, deal);
  const picture = useMemo(
    // Their images failed to load: the avatar it is.
    () => (character ? bannerPicture(character, characterImages.isError ? [] : characterImages.data) : undefined),
    [character, characterImages.data, characterImages.isError],
  );
  // Not the one the banner shows.
  const moreOfCharacter = useMemo(
    () => characterImages.data?.filter((img) => img._id !== picture?.id),
    [characterImages.data, picture],
  );

  const models = useQuery(imageModelsQuery);
  const model = heldPick(held, "model", deal, models.data, (data) =>
    pickOne(data.filter((m) => m.count > 0)),
  );
  const modelFilters = useMemo<Filters | null>(
    () => (model ? { ...DEFAULT_FILTERS, model: model.model } : null),
    [model],
  );
  const modelImages = useRandomImages(modelFilters, deal);

  // Images with no workflow id ("Other images") are no family to filter by.
  const signatures = useSignatures();
  const workflow = heldPick(held, "workflow", deal, signatures.data, (data) =>
    pickOne(groupWorkflows(data).filter((w) => w.id !== null && w.images > 0)),
  );
  const workflowFilters = useMemo<Filters | null>(
    () => (workflow?.id ? { ...DEFAULT_FILTERS, workflow: workflow.id } : null),
    [workflow],
  );
  const workflowImages = useRandomImages(workflowFilters, deal);

  return (
    <>
      <PageHeader
        title="Discover"
        width="wide"
        actions={
          <>
            {/* Icons alone on a phone, so the title keeps its room. */}
            <Button onClick={() => setDeal((d) => d + 1)} aria-label="Shuffle">
              <Shuffle size={16} /> <span className="hidden sm:inline">Shuffle</span>
            </Button>
            <Button variant="primary" onClick={() => void feelLucky()} disabled={busy} aria-label="Random image">
              <Dices size={16} /> <span className="hidden sm:inline">Random image</span>
            </Button>
          </>
        }
      />
      <PageBody width="wide">
        <div className="space-y-6">
          {/* No character with an image: no banner. */}
          {/* A character whose every image is hidden (quarantined, or past
              the sensitivity filter) isn't featured. */}
          {(characters.isPending ||
            (character && (characterImages.isPending || characterImages.isError || !!characterImages.data?.length))) && (
            <DiscoverHero character={character ?? undefined} picture={picture}>
              {/* Their other images, when any are left to show (not the one
                  the banner shows; quarantined ones, or ones past the
                  sensitivity filter, are not shown either). */}
              {characterFilters && (characterImages.isPending ? (character?.count ?? 0) > 1 : !!moreOfCharacter?.length) && (
                <ImageStrip
                  name="discover:character"
                  // As the banner names them.
                  context={character ? (character.name ?? formatTag(character.tag)) : undefined}
                  items={moreOfCharacter}
                  pending={characterImages.isPending}
                  filters={characterFilters}
                  size="sm"
                  // Their other images: one fewer than they have, at most a shelf.
                  placeholders={Math.min(STRIP_SIZE, character ? character.count - 1 : 0)}
                />
              )}
            </DiscoverHero>
          )}

          {shown("unseen", unseen) && (
            <DiscoverSection
              label="Not seen in a while"
              icon={History}
              tint="rose"
              cover={unseen.data?.[0]?.thumb_url}
              // The gallery of them, favorites first.
              viewAll={galleryHref({ ...UNSEEN, sort: "top" })}
            >
              <ImageStrip name="discover:unseen" context="Not seen in a while" items={unseen.data} pending={unseen.isPending} filters={UNSEEN} placeholders={expected(lastCount.get("unseen"))} />
            </DiscoverSection>
          )}

          {shown("top", top) && (
            <DiscoverSection
              label="Top rated"
              icon={Star}
              tint="amber"
              cover={top.data?.[0]?.thumb_url}
              viewAll={shuffled(TOP_RATED)}
            >
              <ImageStrip name="discover:top" context="Top rated" items={top.data} pending={top.isPending} filters={TOP_RATED} placeholders={expected(lastCount.get("top"))} />
            </DiscoverSection>
          )}

          {/* Skeletons while the tags load; nothing if they can't. */}
          {((!rarePick && !tagsFailed) || rare.length >= MIN_SHELF) && (
            <DiscoverSection
              label="Rare tags"
              icon={Gem}
              tint="emerald"
              cover={rare[0]?.thumb_url}
              viewAll="/tags"
            >
              <div className={SHELF}>
                {(!rarePick ? Array.from({ length: RARE_SHOWN }, () => null) : rare).map((t, i) => {
                  const box =
                    "group relative block aspect-[4/5] w-36 shrink-0 snap-start overflow-hidden rounded-xl bg-sunken shadow-tile ring-brand-400 focus-visible:outline-none focus-visible:ring-2 sm:w-40";
                  if (!t || !rarePick) return <Skeleton key={i} className={box} />;
                  return (
                    <Link key={t.tag} to={galleryHref({ tags: [galleryTag(t.tag, rarePick.source)] })} className={box}>
                      {t.thumb_url && (
                        <img
                          src={t.thumb_url}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                          style={{ objectPosition: focusPosition(t.focus ?? null) }}
                        />
                      )}
                      <span className="absolute right-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-emerald-200 backdrop-blur-sm">
                        {t.count}
                      </span>
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2.5 pb-2 pt-10">
                        <span className="line-clamp-2 text-sm font-semibold leading-snug text-neutral-50">{formatTag(t.tag)}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </DiscoverSection>
          )}

          {shown("unscored", unscored) && (
            <DiscoverSection
              label="Unscored"
              icon={Sparkles}
              tint="sky"
              cover={unscored.data?.[0]?.thumb_url}
              viewAll={shuffled(UNSCORED)}
            >
              <ImageStrip name="discover:unscored" context="Unscored" items={unscored.data} pending={unscored.isPending} filters={UNSCORED} placeholders={expected(lastCount.get("unscored"))} />
            </DiscoverSection>
          )}

          {workflow && workflowFilters && shown(`workflow:${workflow.id}`, workflowImages) && (
            <DiscoverSection
              label="Workflow"
              title={workflow.name}
              icon={Workflow}
              tint="cyan"
              cover={workflowImages.data?.[0]?.thumb_url}
              viewAll={shuffled(workflowFilters)}
            >
              <ImageStrip name="discover:workflow" context={workflow.name} items={workflowImages.data} pending={workflowImages.isPending} filters={workflowFilters} placeholders={expected(workflow.images)} />
            </DiscoverSection>
          )}

          {model && modelFilters && shown(`model:${model.model}`, modelImages) && (
            <DiscoverSection
              label="Model"
              title={model.model}
              icon={Layers}
              tint="violet"
              cover={modelImages.data?.[0]?.thumb_url}
              viewAll={shuffled(modelFilters)}
            >
              <ImageStrip name="discover:model" context={model.model} items={modelImages.data} pending={modelImages.isPending} filters={modelFilters} placeholders={expected(model.count)} />
            </DiscoverSection>
          )}
        </div>
      </PageBody>
    </>
  );
}
