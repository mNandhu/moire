import { useId, useMemo, useState } from "react";
import { GitMerge, Pencil } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import type { TagAgg } from "../lib/queries";
import { formatTag, isPrompt, planRename } from "../lib/tags";

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
  const [busy, setBusy] = useState(false);
  const listId = useId();

  const raw = tag?._id ?? "";
  const prompt = isPrompt(raw);
  const plan = useMemo(() => planRename(raw, to, known), [raw, to, known]);
  // Same-kind names to pick from, most used first (the aggregate's order).
  const options = useMemo(
    () => known.filter((t) => t._id !== raw && isPrompt(t._id) === prompt).slice(0, 200),
    [known, raw, prompt],
  );

  const close = () => {
    if (busy) return;
    setTo("");
    onClose();
  };

  const submit = async () => {
    if (!tag || !plan.ok || busy) return;
    setBusy(true);
    const ok = await onRename(raw, to);
    setBusy(false);
    if (ok) {
      setTo("");
      onClose();
    }
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
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!plan.ok || busy}>
            {busy ? "Saving…" : merge ? "Merge" : "Rename"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Input
          autoFocus
          value={to}
          list={listId}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="New name, or an existing tag to merge into"
        />
        <datalist id={listId}>
          {options.map((t) => (
            <option key={t._id} value={formatTag(t._id)} />
          ))}
        </datalist>
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
