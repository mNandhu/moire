import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Dices, Shuffle } from "lucide-react";
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
import { characterFilters as filtersOf, characterHref, focusPosition } from "@/features/characters/lib/character";
import { CharacterAvatar } from "@/features/characters/components/CharacterAvatar";
import { DiscoverSection, ImageStrip } from "@/features/discover/components/DiscoverSection";
import { useRandomImages } from "@/features/discover/lib/queries";
import { heldPick, pickOne, rareTags, type Held } from "@/features/discover/lib/discover";
import { useSignatures } from "@/features/metadata/lib/rules";
import { groupWorkflows } from "@/features/metadata/lib/workflows";
import { useQuery } from "@tanstack/react-query";

const SECTIONS = ["unscored", "top", "forgotten", "workflow", "rare", "character", "model"] as const;
type SectionKey = (typeof SECTIONS)[number];
type Deals = Record<SectionKey, number>;
const FIRST_DEAL: Deals = Object.fromEntries(SECTIONS.map((k) => [k, 0])) as Deals;

const RARE_SHOWN = 12;
const UNSCORED: Filters = { ...DEFAULT_FILTERS, unscored: true };
const TOP_RATED: Filters = { ...DEFAULT_FILTERS, minScore: 4 };
// Top rated, but not opened in a month (or ever, since views were recorded).
const FORGOTTEN: Filters = { ...TOP_RATED, unviewedDays: 30 };
const general = <T extends { category: string; count: number }>(tags: T[]) =>
  tags.filter((t) => t.category === "general" && t.count >= 2);
const shuffled = (f: Filters) => galleryHref({ ...f, sort: "shuffle" });

// Kept while the app is open, so coming back shows the same picks and the
// next Pick again is a deal never seen (each deal's images are cached).
let lastDeals: Deals = FIRST_DEAL;
const held = new Map<string, Held<unknown>>();

/**
 * Discover: random corners of the library. Unscored images, top rated ones,
 * favorites not opened lately, rare tags, one workflow, one character and
 * one model, each a fresh pick on demand.
 */
export default function DiscoverPage() {
  const [deals, setDeals] = useState<Deals>(() => lastDeals);
  useEffect(() => {
    lastDeals = deals;
  }, [deals]);
  const deal = (key: SectionKey) => setDeals((d) => ({ ...d, [key]: d[key] + 1 }));
  const dealAll = () =>
    setDeals((d) => Object.fromEntries(SECTIONS.map((k) => [k, d[k] + 1])) as Deals);
  const { feelLucky, busy } = useLucky(DEFAULT_FILTERS);

  const unscored = useRandomImages(UNSCORED, deals.unscored);
  const top = useRandomImages(TOP_RATED, deals.top);
  const forgotten = useRandomImages(FORGOTTEN, deals.forgotten);

  // AI tags name what is in the picture; until enough images are AI-tagged,
  // every source's tags (prompt words too) fill in.
  const aiTags = useTagBrowse("ai", { staleTime: 60_000 });
  const fewAiTags = !!aiTags.data && general(aiTags.data).length < RARE_SHOWN;
  const allTags = useTagBrowse("all", { staleTime: 60_000, enabled: fewAiTags });
  const tags = fewAiTags ? allTags : aiTags;
  const tagsFailed = aiTags.isError || (fewAiTags && allTags.isError);
  const rarePick = heldPick(held, "rare", deals.rare, tags.data, (data) => ({
    tags: rareTags(general(data), RARE_SHOWN),
    source: fewAiTags ? ("all" as const) : ("ai" as const),
  }));
  const rare = rarePick?.tags ?? [];

  const characters = useCharacters();
  const character = heldPick(held, "character", deals.character, characters.data, (data) =>
    pickOne(data.filter((c) => c.count > 0)),
  );
  // Every name the character goes by, as their page does.
  const characterFilters = useMemo<Filters | null>(
    () => (character ? filtersOf(character.tag, character.aliases) : null),
    [character],
  );
  const characterImages = useRandomImages(characterFilters, deals.character);

  const models = useQuery(imageModelsQuery);
  const model = heldPick(held, "model", deals.model, models.data, (data) =>
    pickOne(data.filter((m) => m.count > 0)),
  );
  const modelFilters = useMemo<Filters | null>(
    () => (model ? { ...DEFAULT_FILTERS, model: model.model } : null),
    [model],
  );
  const modelImages = useRandomImages(modelFilters, deals.model);

  // Images with no workflow id ("Other images") are no family to filter by.
  const signatures = useSignatures();
  const workflow = heldPick(held, "workflow", deals.workflow, signatures.data, (data) =>
    pickOne(groupWorkflows(data).filter((w) => w.id !== null && w.images > 0)),
  );
  const workflowFilters = useMemo<Filters | null>(
    () => (workflow?.id ? { ...DEFAULT_FILTERS, workflow: workflow.id } : null),
    [workflow],
  );
  const workflowImages = useRandomImages(workflowFilters, deals.workflow);

  return (
    <>
      <PageHeader
        title="Discover"
        width="wide"
        actions={
          <>
            <Button onClick={dealAll}>
              <Shuffle size={16} /> Shuffle all
            </Button>
            <Button variant="primary" onClick={() => void feelLucky()} disabled={busy}>
              <Dices size={16} /> Random image
            </Button>
          </>
        }
      />
      <PageBody width="wide">
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(unscored.isPending || !!unscored.data?.length) && (
              <DiscoverSection label="Unscored" onDeal={() => deal("unscored")} viewAll={shuffled(UNSCORED)}>
                <ImageStrip name="discover:unscored" items={unscored.data} pending={unscored.isPending} filters={UNSCORED} />
              </DiscoverSection>
            )}
            {(top.isPending || !!top.data?.length) && (
              <DiscoverSection label="Top rated" onDeal={() => deal("top")} viewAll={shuffled(TOP_RATED)}>
                <ImageStrip name="discover:top" items={top.data} pending={top.isPending} filters={TOP_RATED} />
              </DiscoverSection>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(forgotten.isPending || !!forgotten.data?.length) && (
              <DiscoverSection
                label="Forgotten favorites"
                onDeal={() => deal("forgotten")}
                viewAll={shuffled(FORGOTTEN)}
              >
                <ImageStrip
                  name="discover:forgotten"
                  items={forgotten.data}
                  pending={forgotten.isPending}
                  filters={FORGOTTEN}
                />
              </DiscoverSection>
            )}
            {workflow && workflowFilters && (workflowImages.isPending || !!workflowImages.data?.length) && (
              <DiscoverSection
                label="Workflow"
                title={<span className="block truncate">{workflow.name}</span>}
                onDeal={() => deal("workflow")}
                viewAll={shuffled(workflowFilters)}
              >
                <ImageStrip
                  name="discover:workflow"
                  items={workflowImages.data}
                  pending={workflowImages.isPending}
                  filters={workflowFilters}
                />
              </DiscoverSection>
            )}
          </div>

          {/* Skeletons while the tags load; nothing if they can't. */}
          {((!rarePick && !tagsFailed) || rare.length > 0) && (
            <DiscoverSection label="Rare tags" onDeal={() => deal("rare")} viewAll="/tags">
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {!rarePick
                  ? Array.from({ length: RARE_SHOWN }, (_, i) => (
                      <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />
                    ))
                  : rare.map((t) => (
                      <Link
                        key={t.tag}
                        to={galleryHref({ tags: [galleryTag(t.tag, rarePick.source)] })}
                        className="group relative block aspect-[4/5] overflow-hidden rounded-lg bg-sunken ring-brand-400 focus-visible:outline-none focus-visible:ring-2"
                      >
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
                        <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6 text-xs">
                          <span className="truncate font-medium text-neutral-100">{formatTag(t.tag)}</span>
                          <span className="shrink-0 tabular-nums text-neutral-300">{t.count}</span>
                        </span>
                      </Link>
                    ))}
              </div>
            </DiscoverSection>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* A pick whose images are all hidden (quarantined, or past the
                sensitivity filter) shows nothing rather than an empty strip. */}
            {character && characterFilters && (characterImages.isPending || !!characterImages.data?.length) && (
              <DiscoverSection
                label="Character"
                title={
                  <Link to={characterHref(character.tag)} className="inline-flex items-center gap-2 hover:text-brand-200">
                    <CharacterAvatar
                      src={character.thumb_url}
                      face={character.face}
                      focus={character.focus}
                      aspect={character.aspect}
                      letter={(character.name ?? character.tag).slice(0, 1)}
                      className="h-7 w-7"
                    />
                    <span className="truncate">{character.name ?? formatTag(character.tag)}</span>
                  </Link>
                }
                onDeal={() => deal("character")}
                viewAll={characterHref(character.tag)}
              >
                <ImageStrip
                  name="discover:character"
                  items={characterImages.data}
                  pending={characterImages.isPending}
                  filters={characterFilters}
                />
              </DiscoverSection>
            )}
            {model && modelFilters && (modelImages.isPending || !!modelImages.data?.length) && (
              <DiscoverSection
                label="Model"
                title={<span className="block truncate">{model.model}</span>}
                onDeal={() => deal("model")}
                viewAll={shuffled(modelFilters)}
              >
                <ImageStrip
                  name="discover:model"
                  items={modelImages.data}
                  pending={modelImages.isPending}
                  filters={modelFilters}
                />
              </DiscoverSection>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
