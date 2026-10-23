import type { ReactNode } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Button, Input } from "../ui";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { useToast } from "../Toasts";

/**
 * The dialog around a saved preset, new or edited: its name, the fields
 * the kind adds (`children`), and Delete / Cancel / Save. Mount it only
 * while open: the form's state starts from the preset and is dropped on
 * close. Saving changes the preset for every layer that uses it, so the
 * presets' query refetches and `onSaved` gets the saved preset (null after
 * a delete).
 */
export function PresetDialogShell<P>({
  title,
  editing,
  name,
  onName,
  canSave,
  queryKey,
  save,
  remove,
  onClose,
  onSaved,
  children,
}: {
  title: ReactNode;
  /** An existing preset is being edited (it can be deleted). */
  editing: boolean;
  name: string;
  onName: (v: string) => void;
  /** The kind's own fields are valid; the name is checked here. */
  canSave: boolean;
  queryKey: QueryKey;
  save: () => Promise<P>;
  remove: () => Promise<unknown>;
  onClose: () => void;
  onSaved: (p: P | null) => void;
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const done = (p: P | null) => {
    void qc.invalidateQueries({ queryKey });
    onSaved(p);
    onClose();
  };
  const saving = useMutation({ mutationFn: save, onSuccess: done, onError: (e) => toast.push(e.message, "error") });
  const deleting = useMutation({ mutationFn: remove, onSuccess: () => done(null), onError: (e) => toast.push(e.message, "error") });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <DialogFooter
          onCancel={onClose}
          onConfirm={() => saving.mutate()}
          disabled={!name.trim() || !canSave}
          pending={saving.isPending}
          start={
            editing && (
              <Button variant="ghost" onClick={() => deleting.mutate()} pending={deleting.isPending} className="text-red-300">
                Delete
              </Button>
            )
          }
        />
      }
    >
      <div className="space-y-3">
        <Input aria-label="Preset name" placeholder="Name" value={name} onChange={(e) => onName(e.target.value)} />
        {children}
      </div>
    </Dialog>
  );
}
