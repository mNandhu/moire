import { useMemo, useState } from "react";
import { Tags } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { TagSearchInput } from "./TagSearchInput";
import { useTagAggregate } from "../lib/queries";
import { bulkTagNames, isManual } from "../lib/tags";

/**
 * Add and remove manual tags on a gallery selection in one go. Only manual
 * tags: AI and prompt tags belong to the tagger and the prompt, and a re-run
 * would undo an edit to them anyway. Both boxes autocomplete against the
 * existing manual tags; a new tag can be typed in the add box.
 */
export function BulkTagDialog({
  open,
  count,
  onClose,
  onApply,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  /** Resolves when the edit landed; the dialog closes on success. */
  onApply: (edit: { add: string[]; remove: string[] }) => Promise<boolean>;
}) {
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: tags } = useTagAggregate();
  const manual = useMemo(() => (tags ?? []).filter((t) => isManual(t._id)), [tags]);

  const addNames = bulkTagNames(add);
  const removeNames = bulkTagNames(remove);
  const empty = !addNames.length && !removeNames.length;

  const close = () => {
    if (busy) return;
    setAdd([]);
    setRemove([]);
    onClose();
  };

  const apply = async () => {
    if (empty || busy) return;
    setBusy(true);
    const ok = await onApply({ add: addNames, remove: removeNames });
    setBusy(false);
    if (ok) {
      setAdd([]);
      setRemove([]);
      onClose();
    }
  };

  const plural = count === 1 ? "" : "s";
  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <Tags size={18} className="text-brand-300" /> Edit tags on {count} image{plural}
        </span>
      }
      description="Manual tags only. AI and prompt tags stay as they are."
      className="max-w-lg"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={empty || busy}>
            {busy ? "Applying…" : "Apply"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted">Add</div>
          <TagSearchInput
            value={add}
            onChange={setAdd}
            suggestions={manual}
            placeholder="Type a tag, Enter to add"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted">Remove</div>
          <TagSearchInput
            value={remove}
            onChange={setRemove}
            suggestions={manual}
            placeholder="Tags to take off these images"
          />
        </div>
      </div>
    </Dialog>
  );
}
