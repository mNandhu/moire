import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Shirt, Undo2, X } from "lucide-react";
import { Picker, type PickerOption } from "../ui/Picker";
import { cn } from "../../lib/cn";
import { displayWord } from "../../lib/compose";
import { canonicalName } from "../../lib/tags";
import {
  DEFAULT_OUTFIT,
  thumbUrl,
  useDefaultOutfit,
  useOutfits,
  type Outfit,
} from "../../lib/generate";
import { pickOf, toggleWorn, addWorn, type OutfitPick } from "../../lib/outfit";
import { useTagAggregate, useTagFacets } from "../../lib/queries";
import { bareTagPool } from "./ChipInput";
import { TagSuggestList, useTagMatches } from "../TagSuggestList";

const NO_OUTFIT = "\u0000none";

/** An outfit's thumbnail; a quiet shirt where it has none. */
export function OutfitThumb({ imageId, className }: { imageId: string | null; className?: string }) {
  return imageId ? (
    <img src={thumbUrl(imageId)} alt="" loading="lazy" className={cn("shrink-0 rounded object-cover", className)} />
  ) : (
    <span className={cn("grid shrink-0 place-items-center rounded bg-raised text-faint", className)}>
      <Shirt size={12} />
    </span>
  );
}

/** A character's outfit list for pickers: Default first, their own, then
 * the shared ones they don't hide. */
export function useCharacterOutfits(character: string) {
  const { data: def } = useDefaultOutfit(character);
  const { data: list } = useOutfits(character);
  return useMemo(() => {
    const visible = (list ?? []).filter((o) => !o.hidden);
    const d = def && def.tags.length ? def : null;
    const own = visible.filter((o) => o.character === character);
    const shared = visible.filter((o) => o.character !== character);
    // Attire group per tag, from every outfit in the list.
    const groups = new Map<string, string | null>();
    for (const o of [...(d ? [d] : []), ...own, ...shared]) for (const t of o.tags) groups.set(t.tag, t.group);
    return { def: d, own, shared, groups };
  }, [character, def, list]);
}

function option(o: Outfit, group: string): PickerOption {
  return {
    value: o._id,
    label: o.name,
    group,
    hint: `${o.tags.length} ${o.tags.length === 1 ? "tag" : "tags"}`,
    keywords: o.tags.map((t) => t.tag).join(" "),
    icon: <OutfitThumb imageId={o.image_id} className={cn("h-7 w-5", o._id === DEFAULT_OUTFIT && "outline-dashed outline-1 outline-line-strong")} />,
  };
}

/** What one character wears: Default, their own outfits, shared ones, or
 * nothing. The closed button shows the pick's thumbnail. */
export function OutfitPicker({
  character,
  value,
  onChange,
}: {
  character: string;
  value: OutfitPick | undefined;
  onChange: (pick: OutfitPick | null) => void;
}) {
  const { def, own, shared } = useCharacterOutfits(character);
  const all = [...(def ? [def] : []), ...own, ...shared];
  const options: PickerOption[] = [
    { value: NO_OUTFIT, label: "No outfit" },
    ...(def ? [option(def, "Usual clothes")] : []),
    ...own.map((o) => option(o, "Their outfits")),
    ...shared.map((o) => option(o, "Shared")),
  ];
  const thumb = value ? (all.find((o) => o._id === value.id)?.image_id ?? null) : null;
  return (
    <Picker
      value={value?.id ?? NO_OUTFIT}
      options={options}
      aria-label="Outfit"
      onChange={(v) => {
        if (v === NO_OUTFIT) return onChange(null);
        const o = all.find((x) => x._id === v);
        if (o) onChange(pickOf(o));
      }}
      footer={
        <Link to={`/outfits?character=${encodeURIComponent(character)}`} className="block px-3 py-2 text-xs text-muted hover:text-neutral-100">
          Manage outfits
        </Link>
      }
      trigger={() => (
        <span
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border bg-raised pr-2 text-sm text-neutral-100 hover:border-line-strong",
            value ? "border-line-strong pl-1" : "border-dashed border-line-strong pl-2.5 text-muted",
          )}
          title="What they wear"
        >
          {value && (
            <OutfitThumb
              imageId={thumb}
              className={cn("h-[26px] w-5", value.id === DEFAULT_OUTFIT && "outline-dashed outline-1 outline-line-strong")}
            />
          )}
          <span className="max-w-[12rem] truncate">{value ? value.name : "No outfit"}</span>
          <ChevronDown size={13} className="text-muted" />
        </span>
      )}
    />
  );
}

/**
 * Type a tag to add to an outfit: library tags as suggestions, attire ones
 * first. Free text is allowed (Enter takes it as typed).
 */
export function AttireTagInput({
  onAdd,
  taken,
  className,
}: {
  onAdd: (tag: string) => void;
  taken: ReadonlySet<string>;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const { data: tagAgg } = useTagAggregate({ includePrompt: true });
  const { data: facets } = useTagFacets();
  const pool = useMemo(() => bareTagPool(tagAgg ?? []).filter((t) => !taken.has(t._id)), [tagAgg, taken]);
  const ranked = useTagMatches(text, pool);
  const matches = useMemo(() => {
    const worn = (id: string) => facets?.[id] === "outfit";
    return [...ranked.filter((m) => worn(m._id)), ...ranked.filter((m) => !worn(m._id))];
  }, [ranked, facets]);
  const add = (tag: string) => {
    const t = canonicalName(tag);
    if (t) onAdd(t);
    setText("");
    setMoved(false);
  };
  return (
    <div className={cn("relative", className)}>
      <input
        aria-label="Add outfit tag"
        value={text}
        placeholder="Add tag"
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setMoved(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setMoved(true);
            setActive((a) => (e.key === "ArrowDown" ? Math.min(a + 1, matches.length - 1) : Math.max(a - 1, 0)));
          } else if (e.key === "Tab" && matches.length) {
            e.preventDefault();
            add(matches[active]._id);
          } else if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(moved && matches[active] ? matches[active]._id : text);
          } else if (e.key === "Escape") setText("");
        }}
        className="h-7 w-32 rounded-md border border-dashed border-line-strong bg-transparent px-2 text-sm text-neutral-100 placeholder:text-faint outline-none focus:w-48 focus:border-solid focus:border-brand-600/60"
      />
      {text.trim() && matches.length > 0 && (
        <div className="absolute left-0 top-full z-30 w-64">
          <TagSuggestList
            matches={matches}
            active={active}
            onActive={setActive}
            onPick={(m) => add(m._id)}
            noteOf={(id) => (facets?.[id] === "outfit" ? "attire" : null)}
          />
        </div>
      )}
    </div>
  );
}

/** A tag chip with its attire group; struck ones restore with the arrow. */
export function OutfitChip({
  tag,
  group,
  struck,
  onToggle,
  title,
  className,
}: {
  tag: string;
  group?: string | null;
  struck?: boolean;
  onToggle: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-sm",
        struck ? "border-line/60 text-faint line-through" : "border-line bg-raised text-neutral-100",
        className,
      )}
    >
      {group && <span className="text-[11px] text-muted no-underline">{group.replace(/_/g, " ")}</span>}
      {displayWord(tag)}
      <button
        type="button"
        onClick={onToggle}
        aria-label={`${struck ? "Restore" : "Remove"} ${displayWord(tag)}`}
        className="rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
      >
        {struck ? <Undo2 size={13} /> : <X size={13} />}
      </button>
    </span>
  );
}

/** The picked outfit's chips in the composer: edits apply to this batch. */
export function OutfitChips({
  pick,
  groups,
  onChange,
}: {
  pick: OutfitPick;
  /** Attire group per tag, where the outfit list knows it. */
  groups: ReadonlyMap<string, string | null>;
  onChange: (p: OutfitPick) => void;
}) {
  const struck = new Set(pick.dropped);
  const taken = useMemo(() => new Set(pick.tags), [pick.tags]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pick.tags.map((tag) => (
        <OutfitChip
          key={tag}
          tag={tag}
          group={groups.get(tag)}
          struck={struck.has(tag)}
          onToggle={() => onChange(toggleWorn(pick, tag))}
        />
      ))}
      <AttireTagInput taken={taken} onAdd={(tag) => onChange(addWorn(pick, tag))} />
    </div>
  );
}
