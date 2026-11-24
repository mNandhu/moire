import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toasts";
import { errorText } from "@/lib/api";
import { withBackgroundLocation } from "@/lib/backgroundLocation";
import { stepsState } from "@/lib/stepList";
import { imageHref, type Filters } from "@/features/images/lib/imageFilter";
import {
  IMAGE_FEED_PREFIX,
  IMAGE_GROUPS_PREFIX,
  fetchRandomImages,
  reshuffleImages,
} from "@/features/images/lib/imageApi";

/** The step list a lucky pick opens with: its run of random images. */
const LUCKY_STEPS = "lucky";

/**
 * "I'm feeling lucky": open a random image the gallery filter matches. The
 * view steps through a run of random picks (a step list of its own), not the
 * feed: a random image sits anywhere in it, and finding it there would page
 * through the feed up to it.
 */
export function useLucky(filters: Filters) {
  const navigate = useNavigate();
  const location = useLocation();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  const feelLucky = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const items = await fetchRandomImages(filters);
      if (!items.length) {
        push("No images to pick from", "info");
        return;
      }
      navigate(imageHref(items[0]._id, filters), {
        state: {
          ...withBackgroundLocation(location),
          ...stepsState({ name: LUCKY_STEPS, items }),
        },
      });
    } catch (e) {
      push(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }, [busy, filters, location, navigate, push]);

  return { feelLucky, busy };
}

/** Re-roll the shuffled order, then show the gallery's feed from its start. */
export function useReshuffle() {
  const qc = useQueryClient();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  const reshuffle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await reshuffleImages();
      await Promise.all([
        qc.resetQueries({ queryKey: IMAGE_FEED_PREFIX }),
        qc.resetQueries({ queryKey: IMAGE_GROUPS_PREFIX }),
      ]);
    } catch (e) {
      push(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }, [busy, push, qc]);

  return { reshuffle, busy };
}
