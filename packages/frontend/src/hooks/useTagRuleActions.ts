import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toasts";
import { errorText } from "../lib/api";
import { invalidateFeeds } from "../lib/feedCache";
import { MERGE_SUGGESTIONS_KEY, TAG_RULES_KEY, addTagRules, deleteTagRule, renameTag } from "../lib/queries";
import { acceptMessage, renameMessage, undoRuleMessage } from "../lib/tagBrowse";
import { TAG_SAMPLES_KEY } from "../lib/tagSamples";
import { tagName } from "../lib/tags";

/**
 * The Tags page's tag writes: rename (or merge) a tag, undo a merge rule,
 * accept suggested merges. Each refreshes what a tag write changes and toasts
 * the result. `onRenamed` gets the new bare name; `onAllAccepted` runs when
 * every suggestion asked for was stored.
 */
export function useTagRuleActions({
  onRenamed,
  onAllAccepted,
}: {
  onRenamed: (tag: string) => void;
  onAllAccepted: () => void;
}) {
  const queryClient = useQueryClient();
  const { push } = useToast();

  const afterTagWrite = () => {
    invalidateFeeds(queryClient);
    queryClient.invalidateQueries({ queryKey: TAG_SAMPLES_KEY });
    queryClient.invalidateQueries({ queryKey: TAG_RULES_KEY });
    queryClient.invalidateQueries({ queryKey: MERGE_SUGGESTIONS_KEY });
  };

  const rename = async (tag: string, to: string) => {
    try {
      const res = await renameTag(tag, to);
      afterTagWrite();
      onRenamed(tagName(res.to));
      push(renameMessage(res), "success");
      return true;
    } catch (e) {
      push(`Rename failed: ${errorText(e)}`, "error");
      return false;
    }
  };

  const undoRule = async (from: string) => {
    try {
      const res = await deleteTagRule(from);
      afterTagWrite();
      push(undoRuleMessage(res), "success");
    } catch (e) {
      push(`Couldn't remove the rule: ${errorText(e)}`, "error");
    }
  };

  const acceptSuggestions = async (rules: { from: string; to: string[] }[]) => {
    try {
      const res = await addTagRules(rules);
      afterTagWrite();
      if (res.rules >= rules.length) onAllAccepted();
      push(acceptMessage(res), res.skipped.length ? "info" : "success");
    } catch (e) {
      push(`Merge failed: ${errorText(e)}`, "error");
    }
  };

  return { rename, undoRule, acceptSuggestions };
}
