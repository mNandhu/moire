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
  OUTFITS_KEY,
  createOutfit,
  deleteOutfit,
  fetchOutfitPrefill,
  updateOutfit,
  type Outfit,
} from "../../lib/generate";
import { useTagFacets } from "../../lib/queries";
import { AttireTagInput, OutfitChip, OutfitThumb } from "./Outfit";
import { MAX_OUTFIT_TAGS } from "../../lib/outfit";

type Source = "image" | "usual" | "added";
type Row = { tag: string; group: string | null; checkable: boolean; source: Source };

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
 * edit a saved one (`outfit`, from the Outfits page, with Delete). New: the
 * tags start as the image's attire plus the character's usual ones, each
 * marked by where it came from; the image is the thumbnail.
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
  useEffect(() => {
    if (!open) return setSeeded(false);
    if (seeded) return;
    if (outfit) {
      setName(outfit.name);
      setShared(outfit.shared);
      setRows(outfit.tags.map((t) => ({ ...t, source: "image" })));
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
      const body = { name: name.trim(), tags: rows.map((r) => r.tag), shared };
      return outfit
        ? updateOutfit(outfit._id, body)
        : createOutfit({ ...body, character, image_id: imageId });
    },
    onSuccess: (o) => {
      toast.push(`Saved ${o.name}`, "success");
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
  const ready = !!name.trim() && rows.length > 0 && !tooMany && !save.isPending;

  // On the body: the viewer's side panel is transformed, which would pin a
  // fixed overlay inside it.
  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      placement="top"
      className="max-w-2xl"
      title={
        <span className="flex items-baseline gap-3">
          {outfit ? "Edit outfit" : "Save outfit"}
          <span className="text-sm font-normal text-muted">for {characterName}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2.5">
          {outfit ? (
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
        <OutfitThumb imageId={outfit ? outfit.image_id : imageId} className="h-[140px] w-24 rounded-lg border border-line-strong" />
        <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
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
                    className={cn(SOURCE_STYLE[r.source], !r.checkable && "decoration-dotted")}
                    title={r.checkable ? undefined : "The tagger can't check this one"}
                    onToggle={() => setRows((x) => x.filter((y) => y.tag !== r.tag))}
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
          <div className="rounded-lg border border-line bg-canvas px-3.5 py-3">
            <Checkbox
              checked={shared}
              onChange={setShared}
              label={<span title="Shows in every character's outfit list, marked shared">Available for all characters</span>}
            />
          </div>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
