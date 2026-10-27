import { Badge, Button, Picker, Tooltip } from "../ui";
import { cn } from "../../lib/cn";
import type { GeneratorSetup, GeneratorSlots } from "../../lib/generate";
import { inputAt, pathKey, pickPrompt, pickerOptions, type Side } from "../../lib/generatorSetup";
import { NodeLine, SlotCard } from "./SlotCard";

/** Positive or negative: where Moiré writes the text, and the text the
 * workflow had there (the default Base / negative, editable). */
export function PromptSlot({
  setup,
  side,
  slots,
  onSlots,
  text,
  onText,
  offer,
}: {
  setup: GeneratorSetup;
  side: Side;
  slots: GeneratorSlots;
  onSlots: (s: GeneratorSlots) => void;
  text: string;
  onText: (t: string) => void;
  offer?: { tags: string[]; without: string };
}) {
  const path = slots[side];
  const found = setup.found[side];
  const at = inputAt(setup, path);
  const same = !!found && !!path && found.path[0] === path[0] && found.path[1] === path[1];
  const badge = !path ? (
    <Badge tone="warning">Pick a node</Badge>
  ) : same && found?.from === "rule" ? (
    <Badge tone="success">From your extraction rule</Badge>
  ) : same && setup.found.sampler ? (
    <Badge tone="success">Found from the sampler</Badge>
  ) : (
    <Badge>Picked</Badge>
  );
  return (
    <SlotCard
      title={side === "positive" ? "Positive" : "Negative"}
      badge={badge}
      action={
        <Picker
          aria-label={`Pick the ${side} prompt node`}
          value={path ? pathKey(path) : ""}
          options={pickerOptions(setup, side)}
          searchable
          checks={false}
          align="right"
          onChange={(v) => {
            const input = setup.text_inputs.find((t) => pathKey(t.path) === v);
            if (input) onSlots(pickPrompt(slots, side, input));
          }}
          trigger={({ open }) => (
            <span
              className={cn(
                "inline-flex h-8 items-center rounded-lg border border-line bg-raised px-3 text-xs text-neutral-100 hover:border-line-strong",
                open && "border-brand-500/70",
              )}
            >
              {path ? "Pick another node" : "Pick a node"}
            </span>
          )}
        />
      }
    >
      {path && (
        <NodeLine
          title={at?.title ?? `Node ${path[0]}`}
          path={path}
          extra={
            slots.replace_links?.includes(side) && (
              <Tooltip content="This text is joined while the workflow runs. Writing here replaces the join with Moiré's prompt.">
                <Badge tone="warning">Replaces a join</Badge>
              </Tooltip>
            )
          }
        />
      )}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">
          {side === "positive" ? "Default prompt" : "Default negative"}
        </label>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={side === "positive" ? 4 : 2}
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 outline-none focus-visible:border-brand-500/70"
        />
      </div>
      {offer && offer.tags.length > 0 && text.trim() !== offer.without.trim() && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/50 px-3 py-2 text-[13px]">
          <Tooltip content={offer.tags.join(", ")}>
            <span className="text-neutral-200">
              {offer.tags.length} {offer.tags.length === 1 ? "tag describes" : "tags describe"} a character or outfit
            </span>
          </Tooltip>
          <Tooltip content="Generate's Character and Outfit layers add these at queue time, so the default prompt doesn't need them.">
            <Button size="sm" className="ml-auto" onClick={() => onText(offer.without)}>
              Remove from the prompt
            </Button>
          </Tooltip>
        </div>
      )}
    </SlotCard>
  );
}
