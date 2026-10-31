import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";
import { postAiTag } from "../lib/ai";
import { errorText } from "../lib/api";
import { runBulk } from "../lib/bulk";
import { imageDocKey, invalidateFeeds, removeImagesFromFeeds } from "../lib/feedCache";
import { setQuarantine as apiSetQuarantine, bulkManualTags } from "../lib/imageMutations";

/**
 * The gallery's actions on a selection: quarantine/restore, AI tagging and
 * the bulk tag editor (whose open state lives here too).
 */
export function useBulkActions({
  selection,
  setSelectionMode,
}: {
  selection: Set<string>;
  setSelectionMode: Dispatch<SetStateAction<boolean>>;
}) {
  const { push } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  // These still go through runBulk rather than Promise.all: a thousand selected
  // images used to mean a thousand simultaneous requests at a single-writer
  // SQLite backend, and one rejection hid which writes had already landed.
  // Bounded concurrency plus a per-id account is strictly better, and costs the
  // caller nothing.
  const runBulkQuarantine = useCallback(
    async (ids: string[], next: boolean) => {
      const verb = next ? "Quarantine" : "Restore";
      const ok = await confirm({
        title: `${verb} ${ids.length} selected image${ids.length === 1 ? "" : "s"}?`,
        message: next
          ? "Quarantined images are hidden from the gallery until restored."
          : undefined,
        confirmLabel: verb,
        tone: next ? "warning" : "default",
      });
      if (!ok) return;
      // Either way the tiles leave the current list, so drop them from the
      // cached feeds and the grid updates without a refresh, the way
      // single-image triage does.
      removeImagesFromFeeds(queryClient, ids);
      const res = await runBulk(ids, (id) => apiSetQuarantine(id, next));
      invalidateFeeds(queryClient);

      if (res.failed.length) {
        // Stay in selection mode on a partial failure. Leaving it drops the
        // selection (see useSelectionMode), which would report "912 done, 88
        // failed" and simultaneously throw away the only handle on those 88.
        push(`${res.ok.length} done, ${res.failed.length} failed`, "error");
        return;
      }
      setSelectionMode(false);
      push(
        `${next ? "Quarantined" : "Restored"} ${ids.length} image${ids.length === 1 ? "" : "s"}`,
        "success",
      );
    },
    [queryClient, setSelectionMode, push, confirm],
  );

  const runBulkTag = useCallback(
    async (ids: string[]) => {
      const ok = await confirm({
        title: `Run AI tagging for ${ids.length} selected image${ids.length === 1 ? "" : "s"}?`,
        confirmLabel: "Run tagging",
      });
      if (!ok) return;
      try {
        await postAiTag(ids);
        push(`Queued AI tagging for ${ids.length} images`, "success");
        setSelectionMode(false);
      } catch (e) {
        push(`Failed to start AI job: ${errorText(e)}`, "error");
      }
    },
    [push, setSelectionMode, confirm],
  );

  // One request, applied in chunks (see image_tags.bulk_manual): a failure
  // part-way keeps the chunks before it and says how far it got, and running
  // it again finishes it. The selection stays either way: tagging the keepers
  // is usually followed by acting on the rest.
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const runBulkManualTags = useCallback(
    async (edit: { add: string[]; remove: string[] }) => {
      const ids = Array.from(selection);
      // Also after a failure: the chunks before it were applied.
      const refresh = () => {
        invalidateFeeds(queryClient);
        // ImageView reads the full doc from its own cache entry.
        for (const id of ids) {
          queryClient.invalidateQueries({ queryKey: imageDocKey(id), exact: true });
        }
      };
      try {
        const res = await bulkManualTags(ids, edit);
        refresh();
        push(
          `Updated tags on ${res.modified} of ${ids.length} image${ids.length === 1 ? "" : "s"}`,
          "success",
        );
        return true;
      } catch (e) {
        refresh();
        push(`Failed to update tags: ${errorText(e)}`, "error");
        return false;
      }
    },
    [selection, queryClient, push],
  );

  return { runBulkQuarantine, runBulkTag, runBulkManualTags, bulkTagOpen, setBulkTagOpen };
}
