import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "../ui";
import { Checkbox } from "../ui/Checkbox";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { useConfirm } from "../ConfirmDialog";
import { useToast } from "../Toasts";
import { cn } from "../../lib/cn";
import {
  OUTFITS_KEY,
  createOutfit,
  defaultOutfitKey,
  putDefaultOutfit,
  deleteOutfit,
  fetchOutfitPrefill,
  useDefaultOutfit,
  fetchOutfitTagInfo,
  updateOutfit,
  type Outfit,
} from "../../lib/generate";
import { useAttireGroups, useThumbUrl } from "../../lib/queries";
import { AttireTagInput, OutfitChip, OutfitThumb } from "./Outfit";
import { CoverGrid } from "./OutfitCover";
import { Image as ImageIcon } from "lucide-react";
import {
  MAX_OUTFIT_TAGS,
  outfitModeOf,
  outfitSavePlan,
  seedOutfit,
  suggestOutfitName,
  type OutfitRow as Row,
  type OutfitRowSource as Source,
} from "../../lib/outfit";

const SOURCE_STYLE: Record<Source, string> = {
  image: "",
  usual: "border-dashed border-neutral-500",
  added: "border-brand-700 bg-brand-900/30",
};

function Key({ source, children }: { source: Source; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <i className={cn("inline-block h-2.5 w-3.5 rounded-full border border-line-strong bg-raised", SOURCE_STYLE[source])} />
      {children}
    </span>
  );
}

/**
 * Save an image's attire as an outfit for a character (from the viewer), or
 * edit one (`outfit`): a saved one (with Delete), or a character's Default
 * (rename it, strike computed tags, add your own, Reset to computed). New:
 * the tags start as the image's attire plus the character's usual ones, each
 * marked by where it came from; the image is the thumbnail. Editing, Change
 * opens a grid of the character's images wearing it.
 */
export function SaveOutfitDialog({
  open,
  onClose,
  character,
  characterName,
  imageId,
  outfit,
}: {
  open: boolean;
  onClose: () => void;
  character: string;
  characterName: string;
  imageId: string | null;
  outfit?: Outfit;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: attireGroups } = useAttireGroups();
  const { data: prefill, isError: noPrefill } = useQuery({
    queryKey: [...OUTFITS_KEY, "prefill", imageId ?? "", character],
    queryFn: ({ signal }) => fetchOutfitPrefill(imageId!, character, signal),
    enabled: open && !outfit && !!imageId,
  });
  const [name, setName] = useState("");
  // A new outfit's name follows its tags until you type one.
  const [typed, setTyped] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [shared, setShared] = useState(false);
  const [seeded, setSeeded] = useState(false);
  // Editing: the cover picked in the Change strip (shown open), saved with the rest.
  const [cover, setCover] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const mode = outfitModeOf(outfit, imageId);
  // A new outfit with no image (a character page's New outfit) starts from
  // their usual clothes and picks its thumbnail with Change.
  const shown = outfit || mode === "blank" ? cover : imageId;
  // The outfit's own cover comes with it; only another one is looked up.
  const lookedUp = useThumbUrl(shown && shown === outfit?.image_id ? null : shown);
  const coverUrl = shown && shown === outfit?.image_id ? (outfit?.thumb_url ?? null) : lookedUp;
  const { data: usual, isError: noUsual } = useDefaultOutfit(open && mode === "blank" ? character : null);
  useEffect(() => {
    if (!open) return setSeeded(false);
    if (seeded) return;
    setTyped(!!outfit);
    // Without a prefill (the image or character is gone): start empty.
    if (!outfit && (mode === "blank" ? !usual && !noUsual : !prefill && !noPrefill)) return;
    const seed = seedOutfit(mode, { outfit, prefill, usual });
    setName(seed.name);
    setShared(seed.shared);
    setRows(seed.rows);
    if (seed.cover !== undefined) {
      setCover(seed.cover);
      setChanging(false);
    }
    setSeeded(true);
  }, [open, outfit, prefill, noPrefill, usual, noUsual, seeded, mode]);

  const taken = useMemo(() => new Set(rows.map((r) => r.tag)), [rows]);
  const shownName = typed ? name : suggestOutfitName(rows);
  const done = () => {
    void qc.invalidateQueries({ queryKey: OUTFITS_KEY });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const plan = outfitSavePlan(mode, { outfit, character, imageId, name, shownName, rows, shared, cover });
      return plan.kind === "default"
        ? putDefaultOutfit(character, plan.body)
        : plan.kind === "update"
          ? updateOutfit(plan.id, plan.body)
          : createOutfit(plan.body);
    },
    onSuccess: (o) => {
      if (mode === "default") qc.setQueryData(defaultOutfitKey(character), o);
      toast.push(`Saved ${o.name}`, "success");
      done();
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  const reset = useMutation({
    mutationFn: () => putDefaultOutfit(character, { reset: true }),
    onSuccess: (o) => {
      qc.setQueryData(defaultOutfitKey(character), o);
      done();
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  const remove = useMutation({
    mutationFn: () => deleteOutfit(outfit!._id),
    onSuccess: done,
    onError: (e) => toast.push(e.message, "error"),
  });
  // Struck tags aren't sent, so they don't count.
  const kept = rows.filter((r) => !r.struck);
  const tooMany = kept.length > MAX_OUTFIT_TAGS;
  const ready = (mode === "default" || (!!shownName.trim() && rows.length > 0)) && !tooMany;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement="top"
      className={changing ? "max-w-3xl" : "max-w-2xl"}
      title={
        <span className="flex items-baseline gap-3">
          {mode === "default" ? "Default outfit" : outfit ? "Edit outfit" : mode === "blank" ? "New outfit" : "Save outfit"}
          <span className="text-sm font-normal text-muted">
            {mode === "default" ? `${characterName}, read from ${outfit!.images ?? 0} images` : `for ${characterName}`}
          </span>
        </span>
      }
      footer={
        <DialogFooter
          onCancel={onClose}
          onConfirm={() => save.mutate()}
          confirmLabel={outfit ? "Save changes" : mode === "blank" ? "Create outfit" : "Save outfit"}
          disabled={!ready}
          pending={save.isPending}
          start={
            mode === "default" ? (
              outfit!.edited && (
                <Button variant="ghost" onClick={() => reset.mutate()} title="Back to the name and tags read from their images">
                  Reset to computed
                </Button>
              )
            ) : outfit ? (
              <Button
                variant="ghost"
                className="text-red-300"
                onClick={async () => {
                  if (await confirm({ title: `Delete ${outfit.name}?`, confirmLabel: "Delete", tone: "danger" })) remove.mutate();
                }}
              >
                Delete
              </Button>
            ) : (
              <span className={cn("text-xs", tooMany ? "text-red-300" : "text-muted")}>
                {tooMany ? `${kept.length} of ${MAX_OUTFIT_TAGS} tags` : `${kept.length} ${kept.length === 1 ? "tag" : "tags"}`}
              </span>
            )
          }
        />
      }
    >
      <div className="flex flex-wrap gap-5">
        <div className="relative h-[140px] w-24 shrink-0">
          <OutfitThumb url={coverUrl} className="h-full w-full rounded-lg border border-line-strong" />
          {(outfit || mode === "blank") && (
            <button
              type="button"
              onClick={() => setChanging((x) => !x)}
              aria-expanded={changing}
              className="absolute inset-x-1.5 bottom-1.5 inline-flex h-[26px] items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface/90 text-xs text-neutral-100 hover:bg-raised"
            >
              <ImageIcon size={12} /> {(outfit || mode === "blank" ? cover : imageId) ? "Change" : "Set"}
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">Name</span>
            <Input
              value={shownName}
              onChange={(e) => {
                setName(e.target.value);
                setTyped(true);
              }}
              onFocus={(e) => !typed && e.target.select()}
              maxLength={80}
              placeholder={mode === "default" ? "Default" : undefined}
              autoFocus={!outfit}
            />
          </label>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
              <span className="text-xs font-medium text-muted">Attire tags</span>
              {!outfit && (
                <>
                  {mode !== "blank" && <Key source="image">in this image</Key>}
                  <Key source="usual">{characterName} usually wears</Key>
                </>
              )}
              <Key source="added">added by you</Key>
            </div>
            {!seeded ? (
              <span className="text-sm text-faint">Loading…</span>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {rows.map((r) => (
                  <OutfitChip
                    key={r.tag}
                    tag={r.tag}
                    group={r.group}
                    struck={r.struck}
                    className={cn(!r.struck && SOURCE_STYLE[r.source], !r.checkable && "decoration-dotted")}
                    title={r.checkable ? undefined : "The tagger can't check this one"}
                    onToggle={() =>
                      setRows((x) =>
                        // A Default's computed tag is struck, not removed: it stays restorable.
                        mode === "default" && r.source !== "added"
                          ? x.map((y) => (y.tag === r.tag ? { ...y, struck: !y.struck } : y))
                          : x.filter((y) => y.tag !== r.tag),
                      )
                    }
                  />
                ))}
                <AttireTagInput
                  taken={taken}
                  onAdd={(tag) => {
                    setRows((x) =>
                      x.some((y) => y.tag === tag)
                        ? x
                        : [...x, { tag, group: attireGroups?.[tag.toLowerCase()] ?? null, checkable: true, source: "added" }],
                    );
                    // The tagger's own vocabulary says whether it can check it.
                    void fetchOutfitTagInfo([tag])
                      .then(([info]) =>
                        info && setRows((x) => x.map((y) => (y.tag === tag ? { ...y, group: info.group, checkable: info.checkable } : y))),
                      )
                      .catch(() => {});
                  }}
                />
              </div>
            )}
          </div>
          {mode !== "default" && (
            <div className="rounded-lg border border-line bg-canvas px-3.5 py-3">
              <Checkbox
                checked={shared}
                onChange={setShared}
                label={<span title="Shows in every character's outfit list, marked shared">Available for all characters</span>}
              />
            </div>
          )}
        </div>
      </div>
      {(outfit || mode === "blank") && changing && (
        <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
          <span className="text-xs font-medium text-muted">Thumbnail</span>
          <CoverGrid
            character={character}
            outfit={outfit?._id ?? ""}
            // The tags as they stand in the dialog, not as last saved.
            tags={kept.map((r) => r.tag)}
            value={cover}
            onChange={setCover}
          />
        </div>
      )}
    </Dialog>
  );
}
