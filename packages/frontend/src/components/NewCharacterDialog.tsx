import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, ScanSearch, Upload, X } from "lucide-react";
import { Dialog, DialogFooter } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Input";
import { Picker } from "./ui/Picker";
import { useToast } from "./Toasts";
import { useCharacters } from "../lib/queries";
import { TagSuggestList } from "./TagSuggestList";
import { TagAddInput } from "./TagAddInput";
import { useSuggestNav, useTagMatches } from "../hooks/useSuggestNav";
import { cn } from "../lib/cn";
import { characterHref, characterName, displayName } from "../lib/character";
import { canonicalName, unescapeParens } from "../lib/tags";
import { createCharacter } from "../lib/tagMutations";
import { TAGS_KEY } from "../lib/queries";
import { putDefaultOutfit, putRecipe, useCharacterNames, useComfyModels, useLoraWords } from "../lib/generate";
import { stemOf } from "../lib/modelNames";
import { errorText } from "../lib/api";
import { postAiTagImage, postAiTagImageUrl } from "../lib/ai";
import { pastedLink, refill } from "../lib/pictureTags";

/**
 * Make a character the library has no image of yet: the tagger's name for
 * them (or any), a shown name, a character LoRA, identity tags (offered
 * from the LoRA's training tags) and a Default outfit. A picture of them
 * (pasted, dropped, chosen or linked) fills the tag, identity and outfit
 * from what the tagger sees. Opens their page, or hands the new tag to
 * `onCreated` instead.
 */
export function NewCharacterDialog({
  open,
  onClose,
  onCreated,
  initialTag = "",
}: {
  open: boolean;
  /** Starts the tag field (what was typed in a search), its matches shown. */
  initialTag?: string;
  onClose: () => void;
  onCreated?: (tag: string) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { push } = useToast();
  const [tag, setTag] = useState(initialTag);
  const [name, setName] = useState("");
  const [lora, setLora] = useState("");
  const [identity, setIdentity] = useState<string[]>([]);
  const [outfit, setOutfit] = useState<string[]>([]);
  const [picture, setPicture] = useState<string | null>(null);
  const [link, setLink] = useState("");
  // What the last picture put in each list: a new picture replaces it.
  const fromPicture = useRef<{ identity: string[]; outfit: string[] }>({ identity: [], outfit: [] });
  const fileInput = useRef<HTMLInputElement>(null);
  const [suggest, setSuggest] = useState(!!initialTag);
  const { data: names } = useCharacterNames();
  const { data: everyone } = useCharacters();
  const { data: models } = useComfyModels();
  // All its frequent training tags: for a character, hair and eyes are the point.
  const { data: words } = useLoraWords(lora || null, { describe: true });

  // The tagger's characters the library doesn't have yet.
  const pool = useMemo(() => {
    const have = new Set((everyone ?? []).map((c) => c.tag));
    return (names ?? []).filter((n) => !have.has(n)).map((_id) => ({ _id, count: 0 }));
  }, [names, everyone]);
  const matches = useTagMatches(suggest ? tag : "", pool);
  const wanted = canonicalName(tag).toLowerCase();
  const existing = (everyone ?? []).find((c) => c.tag.toLowerCase() === wanted || c.aliases.some((a) => a.toLowerCase() === wanted));
  // Characters the library already has whose name contains what was typed
  // ("hu tao" finds hu_tao_(genshin_impact)). Said above the field, since the
  // tagger's suggestions below may be unrelated rows.
  const alike = useMemo(() => {
    const q = canonicalName(tag).replace(/_/g, " ").toLowerCase();
    if (q.length < 2 || existing) return [];
    return (everyone ?? [])
      .filter((c) => [c.tag, ...c.aliases].some((n) => n.replace(/_/g, " ").toLowerCase().includes(q)))
      .slice(0, 3);
  }, [tag, existing, everyone]);
  const taken = useMemo(() => new Set([canonicalName(tag), ...identity, ...outfit]), [tag, identity, outfit]);
  const offered = (words ?? []).map((w) => canonicalName(w.word)).filter((w) => !taken.has(w));
  useEffect(() => () => {
    if (picture?.startsWith("blob:")) URL.revokeObjectURL(picture);
  }, [picture]);
  const fromTag = characterName(canonicalName(tag) || "fern_(sousou_no_frieren)");

  const pickTag = (t: string) => {
    setTag(t);
    setSuggest(false);
  };
  const nav = useSuggestNav({
    matches,
    open: suggest && matches.length > 0,
    onPick: (s) => pickTag(s._id),
    onClose: () => setSuggest(false),
    tab: true,
    resetKey: tag,
  });
  const adder = (set: React.Dispatch<React.SetStateAction<string[]>>) => (w: string) => {
    const t = canonicalName(w);
    if (t && !taken.has(t)) set((xs) => [...xs, t]);
  };
  const addIdentity = adder(setIdentity);

  // A file, or a link the server fetches. Cancelled with the dialog.
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const tagPicture = useMutation({
    mutationFn: async (from: File | string) => {
      abort.current?.abort();
      const ctl = (abort.current = new AbortController());
      const tags = typeof from === "string" ? await postAiTagImageUrl(from, ctl.signal) : await postAiTagImage(from, ctl.signal);
      return { from, tags, ctl };
    },
    onSuccess: ({ from, tags, ctl }) => {
      if (ctl.signal.aborted) return;
      setPicture(typeof from === "string" ? from : URL.createObjectURL(from));
      setLink("");
      const who = tags.character_tags[0]?.[0];
      // The tagger's best guess at who it is, unless a tag is already typed.
      const charTag = canonicalName(tag) || (who ? canonicalName(who) : "");
      if (who && !canonicalName(tag)) pickTag(who);
      const prev = fromPicture.current;
      const id = refill(identity, prev.identity, tags.identity.map(canonicalName), new Set([charTag, ...outfit]));
      const out = refill(outfit, prev.outfit, tags.outfit.map(canonicalName), new Set([charTag, ...id.tags]));
      fromPicture.current = { identity: id.added, outfit: out.added };
      setIdentity(id.tags);
      setOutfit(out.tags);
    },
    onError: (e) => {
      // Cancelled (the dialog closed, or a newer picture): nothing to say.
      if (e instanceof DOMException && e.name === "AbortError") return;
      push(`Couldn't tag the picture: ${errorText(e)}`, "error");
    },
  });
  const fromClipboard = (e: React.ClipboardEvent) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    const url = file ? null : pastedLink(e.clipboardData.getData("text"));
    if (!file && !url) return;
    // A picture or a link is never a tag or a name: tag it, wherever pasted.
    e.preventDefault();
    tagPicture.mutate(file ?? url!);
  };

  const create = useMutation({
    mutationFn: async () => {
      const made = await createCharacter({ tag: canonicalName(tag), ...(name.trim() ? { name: name.trim() } : {}) });
      try {
        if (identity.length || lora) {
          await putRecipe(made.tag, { ...(identity.length ? { added: identity } : {}), ...(lora ? { lora } : {}) });
        }
        if (outfit.length) await putDefaultOutfit(made.tag, { added: outfit });
      } catch (e) {
        push(`Made the character, but couldn't save its tags, outfit and LoRA: ${errorText(e)}`, "error");
      }
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
      return made.tag;
    },
    onSuccess: (made) => {
      onClose();
      if (onCreated) onCreated(made);
      else navigate(characterHref(made));
    },
    onError: (e) => push(`Couldn't make the character: ${errorText(e)}`, "error"),
  });

  // Not closed mid-save: its onSuccess still closes and navigates.
  const close = () => {
    if (!create.isPending) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New character"
      className="max-w-lg"
      footer={
        <DialogFooter
          onCancel={close}
          onConfirm={() => create.mutate()}
          confirmLabel="Make character"
          disabled={!canonicalName(tag) || !!existing}
          pending={create.isPending}
        />
      }
    >
      <div className="space-y-5" onPasteCapture={fromClipboard}>
        <Field label="Tag" htmlFor="new-character-tag" hint={existing ? <span className="text-red-300">Already a character</span> : undefined}>
          {alike.length > 0 && (
            <p className="mb-1.5 text-sm text-amber-300">
              Already a character:{" "}
              {alike.map((c, i) => (
                <span key={c.tag}>
                  {i > 0 && ", "}
                  <Link to={characterHref(c.tag)} onClick={onClose} className="underline hover:text-amber-200">
                    {displayName(c).name}
                  </Link>
                </span>
              ))}
            </p>
          )}
          <div className="relative">
            <Input
              id="new-character-tag"
              value={tag}
              placeholder="fern_(sousou_no_frieren)"
              autoComplete="off"
              onChange={(e) => {
                // A name copied out of a prompt keeps ComfyUI's paren escapes.
                setTag(unescapeParens(e.target.value));
                setSuggest(true);
              }}
              onBlur={() => setTimeout(() => setSuggest(false), 150)}
              onKeyDown={nav.onKeyDown}
              {...nav.ariaProps}
            />
            {suggest && matches.length > 0 && (
              <TagSuggestList matches={matches} active={nav.active} onActive={nav.setActive} onPick={(s) => pickTag(s._id)} />
            )}
          </div>
        </Field>

        <Field label="Name" htmlFor="new-character-name">
          <Input id="new-character-name" value={name} placeholder={fromTag.name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Character LoRA">
          <Picker
            aria-label="Character LoRA"
            value={lora}
            options={[
              { value: "", label: "None" },
              ...(models?.loras ?? []).map((n) => ({ value: n, label: stemOf(n), detail: n.includes("/") ? n : undefined })),
            ]}
            onChange={setLora}
            placeholder="None"
            searchable
            className="w-full"
          />
        </Field>

        <Field label="Fill from a picture" htmlFor="new-character-picture">
          <div
            className="flex gap-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
              const url = file ? null : pastedLink(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text"));
              if (file || url) {
                e.preventDefault();
                tagPicture.mutate(file ?? url!);
              }
            }}
          >
            {(picture || tagPicture.isPending) && (
              <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-line bg-canvas">
                {picture && <img src={picture} alt="" className="h-full w-full object-cover" />}
                {tagPicture.isPending && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-neutral-100">
                    <Loader2 size={16} className="animate-spin" />
                  </span>
                )}
              </div>
            )}
            <div className="relative min-w-0 flex-1">
              <ScanSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <Input
                id="new-character-picture"
                aria-label="Picture link"
                value={link}
                placeholder="Paste a picture or its link"
                autoComplete="off"
                disabled={tagPicture.isPending}
                className="pl-9"
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && link.trim()) {
                    e.preventDefault();
                    tagPicture.mutate(link.trim());
                  } else if (e.key === "Escape" && link) {
                    // Clears the box; Escape on an empty one closes the dialog.
                    e.stopPropagation();
                    setLink("");
                  }
                }}
              />
            </div>
            <Button
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              onClick={() => fileInput.current?.click()}
              disabled={tagPicture.isPending}
            >
              <Upload size={14} />
              Choose file
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              aria-label="Picture to tag"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) tagPicture.mutate(file);
                e.target.value = "";
              }}
            />
          </div>
        </Field>

        <TagBox label="Identity" tags={identity} onChange={setIdentity} taken={taken} onAdd={addIdentity}>
          {offered.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {offered.map((w) => (
                <OfferChip key={w} tag={w} onAdd={addIdentity} />
              ))}
            </div>
          )}
        </TagBox>

        <TagBox label="Default outfit" tags={outfit} onChange={setOutfit} taken={taken} onAdd={adder(setOutfit)} />
      </div>
    </Dialog>
  );
}

/** A labelled box of removable tag chips with a completing field to add more. */
function TagBox({
  label,
  tags,
  onChange,
  taken,
  onAdd,
  children,
}: {
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  taken: ReadonlySet<string>;
  onAdd: (tag: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <div
        onMouseDown={(e) => {
          // A click on the box's empty space goes to its input.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            e.currentTarget.querySelector("input")?.focus();
          }
        }}
        className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-line bg-canvas px-1.5 py-1 transition-colors hover:border-line-strong focus-within:border-brand-500/70"
      >
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md border border-line bg-raised py-0.5 pl-2 pr-1 text-sm text-neutral-100">
            {t.replace(/_/g, " ")}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
            >
              <X size={13} />
            </button>
          </span>
        ))}
        <TagAddInput ariaLabel={`Add ${label.toLowerCase()} tag`} taken={taken} onAdd={onAdd} bare commitOnBlur className="min-w-24 flex-1" />
      </div>
      {children}
    </div>
  );
}

/** A tag offered for identity: click to add it. */
function OfferChip({ tag, onAdd }: { tag: string; onAdd: (tag: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onAdd(tag)}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-line-strong bg-raised px-2.5 py-0.5 text-sm text-neutral-200",
        "hover:border-brand-500 hover:text-white",
      )}
    >
      <Plus size={12} />
      {tag.replace(/_/g, " ")}
    </button>
  );
}
