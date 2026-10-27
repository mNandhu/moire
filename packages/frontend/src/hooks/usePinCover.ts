import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toasts";
import { clearTagThumbnail, setTagThumbnail } from "../lib/tagMutations";
import { TAGS_KEY } from "../lib/queries";
import { TAG_SAMPLES_KEY } from "../lib/tagSamples";
import { errorText } from "../lib/api";

/**
 * Pin an image as a tag's cover (a character's avatar), or unpin it. The
 * server crops a new avatar to the face before it answers and the tag lists
 * refetch after, which takes seconds: `pending` names the image until the
 * new cover is in, so it can show as loading. One change at a time.
 */
export function usePinCover(noun: "avatar" | "cover") {
  const qc = useQueryClient();
  const { push } = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const pin = useCallback(
    async (tag: string, imageId: string, { unpin = false } = {}) => {
      if (pending) return false;
      setPending(imageId);
      try {
        if (unpin) await clearTagThumbnail(tag);
        else await setTagThumbnail(tag, imageId);
        await Promise.all([
          qc.invalidateQueries({ queryKey: TAGS_KEY }),
          qc.invalidateQueries({ queryKey: TAG_SAMPLES_KEY }),
        ]);
        return true;
      } catch (e) {
        push(`Couldn't change the ${noun}: ${errorText(e)}`, "error");
        return false;
      } finally {
        setPending(null);
      }
    },
    [pending, qc, push, noun],
  );

  return { pin, pending };
}
