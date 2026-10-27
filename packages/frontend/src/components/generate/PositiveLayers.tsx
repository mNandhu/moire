import { Link } from "react-router-dom";
import { Badge, Button, Card, Tooltip } from "../ui";
import { CharacterLayer } from "./CharacterBlock";
import { StyleLayer } from "./StyleLayer";
import { PromptRepeats } from "./PromptRepeats";
import { PromptInput } from "./PromptInput";
import { AddLayer, EmbeddingLayer, LayerRow, NegativeLayer, PresetControl, TextLayer } from "./Layers";
import { PromptBoard, type BoardLayer } from "./PromptBoard";
import { MAX_CHARACTERS } from "../../lib/generationLimits";
import { insertBlock, presetText, removeBlock, updateBlock, type GenerateForm } from "../../lib/generateForm";
import { setCharacters, setOutfitPick, toggleIdentityOff } from "../../lib/composerEdits";
import { prefixRepeats } from "../../lib/promptRepeats";
import { cn } from "../../lib/cn";
import type { ComfyModels, Generator, LoraPreset, NodeError, Preset } from "../../lib/generate";
import type { RunBar } from "../../lib/generatorRunBar";
import type { TagSuggestion } from "../../lib/tagSuggest";

const NO_STRINGS: string[] = [];

/** The positive prompt's layers in order, "+" between them, then the
 * Negative. */
export function PositiveLayers({
  form,
  setForm,
  gen,
  bar,
  presets,
  loraPresets,
  models,
  usage,
  pool,
  rejected,
  rejectedLoras,
  promptEditor,
  boardLayers,
  boardGlow,
  setupLink,
  addingCharacter,
  setAddingCharacter,
}: {
  form: GenerateForm;
  setForm: React.Dispatch<React.SetStateAction<GenerateForm>>;
  gen: Generator | undefined;
  bar: RunBar;
  presets: Preset[] | undefined;
  loraPresets: LoraPreset[] | undefined;
  models: ComfyModels | undefined;
  usage: Map<string, number>;
  pool: readonly TagSuggestion[];
  rejected: NodeError[] | null;
  rejectedLoras: Set<string>;
  promptEditor: React.ReactNode;
  boardLayers: BoardLayer[];
  boardGlow: number | null;
  setupLink: { text: string; to: string } | undefined;
  /** The "+" between layers asked for another character: the Character
   * layer shows a row with its picker open. */
  addingCharacter: boolean;
  setAddingCharacter: (adding: boolean) => void;
}) {
  const set = <K extends keyof GenerateForm>(k: K, v: GenerateForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const addCharacter = form.characters.length < MAX_CHARACTERS ? () => setAddingCharacter(true) : undefined;
  return (
    <div className="flex flex-col" aria-label="Positive prompt">
      {form.blocks.map((blk, i) => (
        <div key={"id" in blk ? blk.id : blk.kind}>
          {i > 0 && (
            <AddLayer onAdd={(k) => set("blocks", insertBlock(form.blocks, i, k))} onCharacter={addCharacter} />
          )}
          {blk.kind === "prefix" ? (
            <LayerRow
              label="Prefix"
              footer={
                <PromptRepeats
                  repeats={prefixRepeats(presetText(form.prefix, presets), form.prompt)}
                  prompt={form.prompt}
                  onPrompt={(v) => set("prompt", v)}
                />
              }
            >
              <PresetControl kind="positive" value={form.prefix} onChange={(v) => set("prefix", v)} presets={presets} label="Prefix preset" />
            </LayerRow>
          ) : blk.kind === "character" ? (
            <CharacterLayer
              value={form.characters}
              onChange={(tags) => setForm((f) => setCharacters(f, tags))}
              outfits={form.outfits}
              onOutfit={(tag, pick) => setForm((f) => setOutfitPick(f, tag, pick))}
              identityOff={form.identityOff}
              onIdentityOff={(character, tag) => setForm((f) => toggleIdentityOff(f, character, tag))}
              prompt={form.prompt}
              onPrompt={(v) => set("prompt", v)}
              adding={addingCharacter}
              onAdded={() => setAddingCharacter(false)}
              installedLoras={models?.loras ?? NO_STRINGS}
              rejectedLoras={rejectedLoras}
            />
          ) : blk.kind === "prompt" ? (
            <Card
              className={cn(
                "px-4 pb-3 pt-3.5 ring-1 ring-brand-700/70 shadow-[0_0_0_3px_rgb(110_82_214/0.15)]",
                rejected?.some((e) => e.field === "positive") && "ring-red-700",
              )}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-sm font-semibold text-neutral-50">Prompt</span>
                {gen?.defaults?.base && form.prompt.trim() !== gen.defaults.base.trim() && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setForm((f) => ({ ...f, prompt: gen.defaults!.base, negative: gen.defaults!.negative }))}
                  >
                    Use {gen.name}'s prompt
                  </Button>
                )}
              </div>
              {promptEditor}
              <PromptBoard
                prompt={form.prompt}
                onPrompt={(v) => set("prompt", v)}
                layers={boardLayers}
                pool={pool}
                glow={boardGlow != null ? { key: boardGlow, box: "subject" } : null}
              />
            </Card>
          ) : blk.kind === "style" && !bar.loras ? (
            <LayerRow label="Style" className="opacity-60">
              <Tooltip
                content={
                  <div className="space-y-1.5">
                    <p>This workflow has no place for Moiré's LoRAs, so the Style layer and character LoRAs are off.</p>
                    {setupLink && (
                      <Link to={setupLink.to} className="text-brand-300 hover:text-brand-200">
                        Map a LoRA insertion point in its setup
                      </Link>
                    )}
                  </div>
                }
              >
                <Button size="sm" aria-disabled="true" className="cursor-default" tabIndex={0}>
                  Add LoRA
                </Button>
              </Tooltip>
              <Badge>Off for this workflow</Badge>
            </LayerRow>
          ) : blk.kind === "style" ? (
            <StyleLayer
              value={form.loras}
              onChange={(v) => set("loras", v)}
              installed={models?.loras ?? NO_STRINGS}
              usage={usage}
              invalid={rejectedLoras}
              presets={loraPresets}
            />
          ) : blk.kind === "text" ? (
            <TextLayer
              value={blk.text}
              onChange={(text) => set("blocks", updateBlock(form.blocks, blk.id, { text }))}
              onRemove={() => set("blocks", removeBlock(form.blocks, blk.id))}
            />
          ) : blk.kind === "preset" ? (
            <LayerRow label="Preset" onRemove={() => set("blocks", removeBlock(form.blocks, blk.id))}>
              <PresetControl
                kind="positive"
                value={blk.preset}
                onChange={(preset) => set("blocks", updateBlock(form.blocks, blk.id, { preset }))}
                presets={presets}
                label="Preset"
              />
            </LayerRow>
          ) : (
            <EmbeddingLayer
              value={blk.name}
              onChange={(name) => set("blocks", updateBlock(form.blocks, blk.id, { name }))}
              onRemove={() => set("blocks", removeBlock(form.blocks, blk.id))}
              embeddings={models?.embeddings ?? NO_STRINGS}
            />
          )}
        </div>
      ))}
      <AddLayer
        onAdd={(k) => set("blocks", insertBlock(form.blocks, form.blocks.length, k))}
        onCharacter={addCharacter}
      />
      <NegativeLayer
        preset={form.negativePreset}
        onPreset={(v) => set("negativePreset", v)}
        presets={presets}
        text={form.negative}
      >
        <PromptInput
          label="Negative prompt"
          value={form.negative}
          onChange={(v) => set("negative", v)}
          suggestions={pool}
          embeddings={models?.embeddings ?? NO_STRINGS}
          rows={2}
          placeholder="More to avoid"
          invalid={rejected?.some((e) => e.field === "negative")}
          className="text-sm"
        />
      </NegativeLayer>
    </div>
  );
}
