import { Undo2, X } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { Cover, Placed } from "../../../lib/promptBoard";
import { formatWeight } from "../../../lib/tags";
import { CharacterAvatar } from "../../CharacterAvatar";
import { Tooltip } from "../../ui";
import { TagPreview } from "./TagPreview";
import { TONE } from "./tone";

export function Chip({
  term,
  counts,
  repeated,
  onRemove,
  swap,
}: {
  term: Placed;
  counts: Map<string, number>;
  repeated?: boolean;
  onRemove?: () => void;
  swap?: { label: string; run: () => void };
}) {
  const label = term.kind === "lora" ? term.name.replace(/^<lora:|>$/g, "").split(":")[0] : term.written;
  const alias = !!term.place?.alias_of;
  return (
    <Tooltip content={<TagPreview term={term} count={counts.get(term.place?.alias_of ?? term.name)} swap={swap} />}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex cursor-default items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs outline-none",
          term.dropped ? "border-line/60 text-faint line-through" : TONE[term.box],
          alias && "border-dashed border-amber-400/70",
          repeated && "ring-1 ring-amber-400/70",
        )}
      >
        {label}
        {term.weight != null && <span className="text-[10px] opacity-70">{formatWeight(term.weight)}</span>}
        {onRemove && (
          <button
            type="button"
            aria-label={`${term.dropped ? "Bring back" : "Remove"} ${label}`}
            onClick={onRemove}
            className="-mr-0.5 rounded no-underline opacity-50 hover:bg-white/10 hover:opacity-100"
          >
            {term.dropped ? <Undo2 size={12} /> : <X size={12} />}
          </button>
        )}
      </span>
    </Tooltip>
  );
}

/** A layer's tags in a box, on their own line: a character's avatar and
 * name, else the layer's name. */
export function CoverRow({ cover, counts }: { cover: Cover; counts: Map<string, number> }) {
  const c = cover.layer.character;
  const shown = cover.terms.filter((t) => !t.self);
  const allOff = shown.length > 0 && shown.every((t) => t.dropped);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 transition-opacity", allOff && "opacity-50")}>
      <span className="inline-flex items-center gap-1.5 pr-0.5 text-xs text-muted">
        {c && <CharacterAvatar src={c.thumb_url} face={c.face} focus={c.focus} aspect={c.aspect} letter={cover.layer.label} className="h-5 w-5 ring-1 ring-line" />}
        {cover.layer.label}
      </span>
      {shown.map((t) => (
        <Chip key={t.name} term={t} counts={counts} onRemove={t.onToggle} />
      ))}
    </div>
  );
}
