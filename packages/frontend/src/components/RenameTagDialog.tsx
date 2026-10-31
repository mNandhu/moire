import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { GitMerge, Pencil } from "lucide-react";
import { Dialog, DialogFooter } from "./ui/Dialog";
import { Input } from "./ui/Input";
import { TagSuggestList } from "./TagSuggestList";
import { useSuggestNav, useTagMatches } from "../hooks/useSuggestNav";
import type { TagAgg } from "../lib/queries";
import { formatTag, isPrompt, planRename, renameOptions } from "../lib/tags";

/**
 * Rename a manual tag or merge a prompt tag into another name. Typing an
 * existing name of the same kind turns the rename into a merge, and the
 * preview says so before anything is written. Prompt merges are stored as a
 * rule (prompt tags are rebuilt from the prompt), listed under Merge rules.
 */
export function RenameTagDialog({
  tag,
  known,
  onClose,
  onRename,
}: {
  /** The tag being renamed; null closes the dialog. */
  tag: TagAgg | null;
  /** Every tag, to detect a merge. */
  known: readonly TagAgg[];
  onClose: () => void;
  /** Resolves true when the rename landed. */
  onRename: (tag: string, to: string) => Promise<boolean>;
}) {
  const [to, setTo] = useState("");
  const [suggesting, setSuggesting] = useState(false);

  const raw = tag?._id ?? "";
  const prompt = isPrompt(raw);
  const plan = useMemo(() => planRename(raw, to, known), [raw, to, known]);
  // Same-kind names to pick from; the dropdown shows the best few matches.
  const options = useMemo(() => renameOptions(raw, known), [known, raw]);

  const matches = useTagMatches(to, options);
  // Nothing to offer once the text already is the highlighted name.
  const showList =
    suggesting && matches.length > 0 && !(matches.length === 1 && formatTag(matches[0]._id) === to);
  const pick = (id: string) => {
    setTo(formatTag(id));
    setSuggesting(false);
  };
  const nav = useSuggestNav({
    matches,
    open: showList,
    onPick: (s) => pick(s._id),
    // Closes the list; the dialog's own Escape skips an open popup.
    onClose: () => setSuggesting(false),
    resetKey: to,
  });

  const reset = () => {
    setTo("");
    onClose();
  };
  const rename = useMutation({
    mutationFn: () => onRename(raw, to),
    onSuccess: (ok) => {
      if (ok) reset();
    },
  });
  const close = () => {
    if (!rename.isPending) reset();
  };

  const submit = () => {
    if (!tag || !plan.ok || rename.isPending) return;
    rename.mutate();
  };

  const merge = plan.ok && !!plan.existing;
  const count = tag?.count ?? 0;
  const images = `${count.toLocaleString()} image${count === 1 ? "" : "s"}`;
  return (
    <Dialog
      open={!!tag}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          {merge ? (
            <GitMerge size={18} className="text-brand-300" />
          ) : (
            <Pencil size={18} className="text-brand-300" />
          )}
          {merge ? "Merge" : "Rename"} “{formatTag(raw)}”
        </span>
      }
      description={
        prompt
          ? "Prompt tags come from your prompts, so this is saved as a merge rule and kept on every re-extraction. Undo it under Merge rules."
          : "Renames this manual tag on every image that has it."
      }
      className="max-w-md"
      footer={
        <DialogFooter
          onCancel={close}
          onConfirm={submit}
          confirmLabel={merge ? "Merge" : "Rename"}
          disabled={!plan.ok}
          pending={rename.isPending}
        />
      }
    >
      <div className="space-y-2">
        <div className="relative">
          <Input
            autoFocus
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setSuggesting(true);
            }}
            onBlur={() => setSuggesting(false)}
            onKeyDown={(e) => {
              if (nav.onKeyDown(e)) return;
              // The first Enter takes the highlighted name; the next submits.
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="New name, or an existing tag to merge into"
            {...nav.ariaProps}
          />
          {showList && (
            <TagSuggestList
              matches={matches}
              active={nav.active}
              onActive={nav.setActive}
              onPick={(s) => pick(s._id)}
            />
          )}
        </div>
        <p className="text-xs text-muted min-h-4">
          {to.trim() === ""
            ? `On ${images}.`
            : !plan.ok
              ? plan.reason
              : plan.existing
                ? `Merges into “${formatTag(plan.target)}” (${plan.existing.count.toLocaleString()} images). ${images} move over.`
                : `Renames on ${images}.`}
        </p>
      </div>
    </Dialog>
  );
}
