import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Shirt } from "lucide-react";
import { Badge, DropdownMenu, EmptyState, Input, PageBody, PageHeader } from "../components/ui";
import { Picker, type PickerOption } from "../components/ui/Picker";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { useCharacterLookup } from "../components/ImageCharacters";
import { OutfitThumb } from "../components/generate/Outfit";
import { SaveOutfitDialog } from "../components/generate/SaveOutfitDialog";
import { useOutfitActions } from "../components/generate/CharacterOutfits";
import { cn } from "../lib/cn";
import { displayName } from "../lib/character";
import { displayWord } from "../lib/compose";
import { fuzzyRank } from "../lib/fuzzy";
import { useOutfits, type Outfit } from "../lib/generate";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type Show = "all" | "shared" | "own";
const SHOW_LABEL: Record<Show, string> = { all: "All", shared: "Shared", own: "One character" };
const EVERYONE = "";

function usedLine(o: Outfit): string {
  if (!o.batches) return "Not generated yet";
  const batches = `Used in ${o.batches} ${o.batches === 1 ? "batch" : "batches"}`;
  return o.used_by && o.used_by > 1 ? `${batches}, ${o.used_by} characters` : batches;
}

function OutfitCard({ o }: { o: Outfit }) {
  const lookup = useCharacterLookup();
  const who = lookup.get(o.character);
  const name = displayName(who ?? { tag: o.character }).name;
  const shown = o.tags.slice(0, 3);
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-panel hover:border-line-strong">
      <div className="aspect-[4/3] overflow-hidden bg-raised">
        <OutfitThumb imageId={o.image_id} className="h-full w-full rounded-none [&>svg]:h-6 [&>svg]:w-6" />
      </div>
      <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-3">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-neutral-50">{o.name}</h3>
          {o.shared && <Badge tone="brand">Shared</Badge>}
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          {o.shared ? (
            `From ${name}, any character`
          ) : (
            <>
              {who && <CharacterAvatar src={who.thumb_url} face={who.face} focus={who.focus} aspect={who.aspect} className="h-4 w-4" />}
              {name}
            </>
          )}
        </span>
        <div className="flex flex-wrap gap-1">
          {shown.map((t) => (
            <span key={t.tag} className="rounded-full border border-line bg-raised px-2 py-0.5 text-[11.5px] text-neutral-300">
              {displayWord(t.tag)}
            </span>
          ))}
          {o.tags.length > shown.length && (
            <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[11.5px] text-neutral-300">
              +{o.tags.length - shown.length}
            </span>
          )}
        </div>
        <span className="text-xs text-faint">{usedLine(o)}</span>
      </div>
    </article>
  );
}

/** A card that opens its actions on click, worn by the character it was made for. */
function OutfitCardMenu({ o, onEdit }: { o: Outfit; onEdit: () => void }) {
  const lookup = useCharacterLookup();
  const name = displayName(lookup.get(o.character) ?? { tag: o.character }).name;
  const actions = useOutfitActions(o.character, name);
  return <DropdownMenu aria-label={`${o.name} actions`} trigger={<OutfitCard o={o} />} items={actions(o, onEdit)} />;
}

/** Every saved outfit: search, a character filter, All / Shared / One
 * character. A card opens the outfit to edit (or delete). */
export default function OutfitsPage() {
  useDocumentTitle("Outfits");
  const { data, isLoading } = useOutfits();
  const lookup = useCharacterLookup();
  const [params, setParams] = useSearchParams();
  const character = params.get("character") ?? EVERYONE;
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [editing, setEditing] = useState<Outfit | null>(null);
  const all = useMemo(() => data ?? [], [data]);

  const owners: PickerOption[] = useMemo(() => {
    const tags = [...new Set(all.map((o) => o.character))];
    return [
      { value: EVERYONE, label: "All characters" },
      ...tags
        .map((tag) => ({ tag, entry: lookup.get(tag) }))
        .map(({ tag, entry }) => ({
          value: tag,
          label: displayName(entry ?? { tag }).name,
          icon: entry ? <CharacterAvatar src={entry.thumb_url} face={entry.face} focus={entry.focus} aspect={entry.aspect} className="h-5 w-5" /> : undefined,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [all, lookup]);

  const shown = useMemo(() => {
    // A character's list holds the shared ones too, as in Generate.
    let list = character ? all.filter((o) => o.character === character || o.shared) : all;
    if (show === "shared") list = list.filter((o) => o.shared);
    if (show === "own") list = list.filter((o) => !o.shared);
    if (q.trim()) list = fuzzyRank(q.trim(), list, (o) => `${o.name} ${o.tags.map((t) => displayWord(t.tag)).join(" ")}`, list.length);
    return list;
  }, [all, character, show, q]);

  const sharedCount = all.filter((o) => o.shared).length;
  const editingWho = editing ? displayName(lookup.get(editing.character) ?? { tag: editing.character }).name : "";

  return (
    <>
      <PageHeader
        title="Outfits"
        description={data ? `${all.length} saved, ${sharedCount} shared` : undefined}
        width="wide"
      />
      <PageBody width="wide">
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <div className="relative w-80 max-w-full">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input aria-label="Search outfits" placeholder="Search names and tags" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <div className="w-52">
            <Picker
              value={character}
              options={owners}
              aria-label="Character"
              onChange={(v) =>
                setParams((p) => {
                  if (v) p.set("character", v);
                  else p.delete("character");
                  return p;
                }, { replace: true })
              }
            />
          </div>
          <div role="radiogroup" aria-label="Show" className="inline-flex rounded-lg border border-line p-0.5">
            {(["all", "shared", "own"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={show === s}
                onClick={() => setShow(s)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs",
                  show === s ? "bg-raised text-neutral-100" : "text-muted hover:text-neutral-100",
                )}
              >
                {SHOW_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        {!isLoading && !shown.length ? (
          <EmptyState icon={Shirt} title={all.length ? "No outfits match" : "No outfits yet"} />
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {shown.map((o) => (
              <OutfitCardMenu key={o._id} o={o} onEdit={() => setEditing(o)} />
            ))}
          </div>
        )}
      </PageBody>
      {editing && (
        <SaveOutfitDialog
          open
          onClose={() => setEditing(null)}
          character={editing.character}
          characterName={editingWho}
          imageId={editing.image_id}
          outfit={editing}
        />
      )}
    </>
  );
}
