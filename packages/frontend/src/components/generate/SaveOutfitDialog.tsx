import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "../ui";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { useConfirm } from "../ConfirmDialog";
import { useToast } from "../Toasts";
import { cn } from "../../lib/cn";
import {
  DEFAULT_OUTFIT,
  OUTFITS_KEY,
  createOutfit,
  defaultOutfitKey,
  putDefaultOutfit,
  deleteOutfit,
  fetchOutfitPrefill,
  updateOutfit,
  type Outfit,
} from "../../lib/generate";
import { useTagFacets } from "../../lib/queries";
import { AttireTagInput, OutfitChip, OutfitThumb } from "./Outfit";
import { CoverGrid } from "./OutfitCover";
import { Image as ImageIcon } from "lucide-react";
import { MAX_OUTFIT_TAGS } from "../../lib/outfit";

type Source = "image" | "usual" | "added";
/** `struck`: a Default's computed tag left out (restorable). */
type Row = { tag: string; group: string | null; checkable: boolean; source: Source; struck?: boolean };

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
  const { data: facets } = useTagFacets();
  const { data: prefill, isError: noPrefill } = useQuery({
    queryKey: [...OUTFITS_KEY, "prefill", imageId ?? "", character],
    queryFn: ({ signal }) => fetchOutfitPrefill(imageId!, character, signal),
    enabled: open && !outfit && !!imageId,
  });
  const [name, setName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [shared, setShared] = useState(false);
  const [seeded, setSeeded] = useState(false);
  // Editing: the cover picked in the Change strip (shown open), saved with the rest.
  const [cover, setCover] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const isDefault = outfit?._id === DEFAULT_OUTFIT;
  useEffect(() => {
    if (!open) return setSeeded(false);
    if (seeded) return;
    if (outfit) {
      setCover(outfit.image_id);
      setChanging(false);
      setName(outfit._id === DEFAULT_OUTFIT && outfit.name === "Default" ? "" : outfit.name);
      setShared(outfit.shared);
      setRows(
        outfit.chips
          ? outfit.chips.map((c) => ({ ...c, source: c.added ? "added" : "image", struck: c.dropped }))
          : outfit.tags.map((t) => ({ ...t, source: "image" })),
      );
      setSeeded(true);
    } else if (prefill || noPrefill || !imageId) {
      // Without a prefill (the image or character is gone): start empty.
      setName("");
      setShared(false);
      setRows((prefill?.tags ?? []).map((t) => ({ ...t, source: t.source })));
      setSeeded(true);
    }
  }, [open, outfit, prefill, noPrefill, imageId, seeded]);

  const taken = useMemo(() => new Set(rows.map((r) => r.tag)), [rows]);
  const done = () => {
    void qc.invalidateQueries({ queryKey: OUTFITS_KEY });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      if (isDefault) {
        return putDefaultOutfit(character, {
          name: name.trim(),
          dropped: rows.filter((r) => r.struck).map((r) => r.tag),
          added: rows.filter((r) => r.source === "added").map((r) => r.tag),
          ...(cover !== outfit!.image_id ? { image_id: cover } : {}),
        });
      }
      const body = { name: name.trim(), tags: rows.map((r) => r.tag), shared };
      return outfit
        ? updateOutfit(outfit._id, cover !== outfit.image_id ? { ...body, image_id: cover } : body)
        : createOutfit({ ...body, character, image_id: imageId });
    },
    onSuccess: (o) => {
      if (isDefault) qc.setQueryData(defaultOutfitKey(character), o);
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
  const tooMany = rows.length > MAX_OUTFIT_TAGS;
  const ready = (isDefault || (!!name.trim() && rows.length > 0)) && !tooMany && !save.isPending;

  // On the body: the viewer's side panel is transformed, which would pin a
  // fixed overlay inside it.
  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      placement="top"
      className={changing ? "max-w-3xl" : "max-w-2xl"}
      title={
        <span className="flex items-baseline gap-3">
          {isDefault ? "Default outfit" : outfit ? "Edit outfit" : "Save outfit"}
          <span className="text-sm font-normal text-muted">
            {isDefault ? `${characterName}, read from ${outfit!.images ?? 0} images` : `for ${characterName}`}
          </span>
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2.5">
          {isDefault ? (
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
              {tooMany ? `${rows.length} of ${MAX_OUTFIT_TAGS} tags` : `${rows.length} ${rows.length === 1 ? "tag" : "tags"}`}
            </span>
          )}
          <Button variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => save.mutate()}>
            {outfit ? "Save changes" : "Save outfit"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap gap-5">
        <div className="relative h-[140px] w-24 shrink-0">
          <OutfitThumb imageId={outfit ? cover : imageId} className="h-full w-full rounded-lg border border-line-strong" />
          {outfit && (
            <button
              type="button"
              onClick={() => setChanging((x) => !x)}
              aria-expanded={changing}
              className="absolute inset-x-1.5 bottom-1.5 inline-flex h-[26px] items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface/90 text-xs text-neutral-100 hover:bg-raised"
            >
              <ImageIcon size={12} /> Change
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder={isDefault ? "Default" : undefined}
              autoFocus={!outfit}
            />
          </label>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
              <span className="text-xs font-medium text-muted">Attire tags</span>
              {!outfit && (
                <>
                  <Key source="image">in this image</Key>
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
                        isDefault && r.source !== "added"
                          ? x.map((y) => (y.tag === r.tag ? { ...y, struck: !y.struck } : y))
                          : x.filter((y) => y.tag !== r.tag),
                      )
                    }
                  />
                ))}
                <AttireTagInput
                  taken={taken}
                  onAdd={(tag) =>
                    setRows((x) =>
                      x.some((y) => y.tag === tag)
                        ? x
                        : [...x, { tag, group: null, checkable: !facets || tag in facets, source: "added" }],
                    )
                  }
                />
              </div>
            )}
          </div>
          {!isDefault && (
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
      {outfit && changing && (
        <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
          <span className="text-xs font-medium text-muted">Thumbnail</span>
          <CoverGrid character={character} outfit={outfit._id} value={cover} onChange={setCover} />
        </div>
      )}
    </Dialog>,
    document.body,
  );
}
