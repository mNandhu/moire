import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Dialog, DialogFooter } from "./ui/Dialog";
import { Field, Input } from "./ui/Input";
import { Picker } from "./ui/Picker";
import { useToast } from "./Toasts";
import { useCharacters } from "../lib/queries";
import { TagSuggestList } from "./TagSuggestList";
import { useSuggestNav, useTagMatches } from "../hooks/useSuggestNav";
import { cn } from "../lib/cn";
import { characterHref, characterName, displayName } from "../lib/character";
import { canonicalName } from "../lib/tags";
import { createCharacter } from "../lib/tagMutations";
import { TAGS_KEY } from "../lib/queries";
import { putRecipe, useCharacterNames, useComfyModels, useLoraWords } from "../lib/generate";
import { stemOf } from "../lib/modelNames";
import { errorText } from "../lib/api";

/**
 * Make a character the library has no image of yet: the tagger's name for
 * them (or any), a shown name, a character LoRA, and identity tags (offered
 * from the LoRA's training tags). Opens their page, or hands the new tag to
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
  const [typed, setTyped] = useState("");
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
  const offered = (words ?? []).map((w) => w.word).filter((w) => !identity.includes(canonicalName(w)));
  const fromTag = characterName(canonicalName(tag) || "character");

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
  const addIdentity = (w: string) => {
    const t = canonicalName(w);
    if (t && !identity.includes(t)) setIdentity((xs) => [...xs, t]);
  };

  const create = useMutation({
    mutationFn: async () => {
      // A tag typed but not yet added with Enter still counts.
      const tags = typed.trim() && !identity.includes(canonicalName(typed)) ? [...identity, canonicalName(typed)] : identity;
      const made = await createCharacter({ tag: canonicalName(tag), ...(name.trim() ? { name: name.trim() } : {}) });
      try {
        if (tags.length || lora) {
          await putRecipe(made.tag, { ...(tags.length ? { added: tags } : {}), ...(lora ? { lora } : {}) });
        }
      } catch (e) {
        push(`Made the character, but couldn't save its tags and LoRA: ${errorText(e)}`, "error");
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New character"
      className="max-w-lg"
      footer={
        <DialogFooter
          onCancel={onClose}
          onConfirm={() => create.mutate()}
          confirmLabel="Make character"
          disabled={!canonicalName(tag) || !!existing}
          pending={create.isPending}
        />
      }
    >
      <div className="space-y-5">
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
                setTag(e.target.value);
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

        <Field label="Identity">
          <div className="flex flex-wrap items-center gap-1.5">
            {identity.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-md border border-line bg-raised py-0.5 pl-2 pr-1 text-sm text-neutral-100">
                {t.replace(/_/g, " ")}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => setIdentity((xs) => xs.filter((x) => x !== t))}
                  className="rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
                >
                  <X size={13} />
                </button>
              </span>
            ))}
            <input
              aria-label="Add identity tag"
              value={typed}
              placeholder="Add tag"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === ",") && typed.trim()) {
                  e.preventDefault();
                  addIdentity(typed);
                  setTyped("");
                }
              }}
              className="h-7 w-32 rounded-md border border-dashed border-line bg-transparent px-2 text-sm text-neutral-100 placeholder:text-faint outline-none focus:border-brand-600/60"
            />
          </div>
          {offered.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {offered.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => addIdentity(w)}
                  title="From the LoRA's training tags"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border border-line-strong bg-raised px-2.5 py-0.5 text-sm text-neutral-200",
                    "hover:border-brand-500 hover:text-white",
                  )}
                >
                  <Plus size={12} />
                  {w}
                </button>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Dialog>
  );
}
