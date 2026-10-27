import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { FeedItem } from "../lib/imageFilter";

/** Wait this long before fetching; hovering past a tile shouldn't hit the API. */
const HOVER_INTENT_MS = 350;
/** How long each member is shown, including the crossfade into it. Long enough
 * that a frame gets a settled dwell after the ~300ms fade in ThumbnailTile:
 * important for a 2-member batch, where a short interval just reads as an A/B
 * strobe rather than a cycle. */
const FRAME_MS = 1500;
/** Members fetched per batch; enough to convey the batch, bounded per hover. */
const MAX_MEMBERS = 12;

/**
 * Cycles a batch tile through its members while the pointer rests on it.
 *
 * In the grouped view a batch of twenty variations collapses to one tile, and
 * the only way to see what else is in it is to drill in and come back. Since
 * batches are usually near-identical seeds of one prompt, a peek is enough to
 * decide whether the batch is worth opening, which is what this gives, without
 * a navigation.
 *
 * Deliberately hover-intent gated and fetched at most once per tile: the
 * grouped feed can show hundreds of batches, and a request per pointer-cross
 * would be worse than the problem it solves.
 *
 * `peekQuery` carries the gallery's active filters (tags, quarantined, etc.)
 * so the peek is scoped the same way the grouped feed picked this tile's
 * representative; see serializeFiltersForPeek. Fetched once per tile
 * (`fetchedRef`), so a filter change after a peek has already been cached
 * won't be reflected until the tile remounts; that's an acceptable gap for a
 * hover nicety.
 */
export function useBatchScrub(
  groupId: string | undefined,
  active: boolean,
  peekQuery: string,
) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [frame, setFrame] = useState(0);
  // Marks that this tile's members have been *successfully* resolved, so a
  // second hover reuses them instead of refetching.
  //
  // It is deliberately not set before the request: doing that meant a hover
  // that ended while the fetch was in flight, i.e. any hover just past the
  // 350ms intent delay, left the flag set with no frames stored, and the guard
  // below then blocked every later hover. Batch peek stayed dead for that tile
  // for the rest of its mounted life.
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!active || !groupId || fetchedRef.current) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams(peekQuery);
        params.set("group_id", groupId);
        params.set("limit", String(MAX_MEMBERS));
        const docs = await api<FeedItem[]>(`/api/v1/images?${params.toString()}`);
        if (cancelled) return;
        const urls = docs
          .map((d) => d.thumb_url)
          .filter((u): u is string => !!u);
        // Decode every frame up front so the crossfade in ThumbnailTile never
        // reveals an empty layer: a keyed/layered <img> paints nothing until
        // its src has loaded, unlike the old single-element swap which kept
        // showing the previous frame while the next one fetched.
        urls.forEach((u) => {
          const img = new Image();
          img.src = u;
        });
        fetchedRef.current = true;
        setFrames(urls.length > 1 ? urls : null);
      } catch {
        // Peeking is a nicety; a failed fetch just leaves the still tile, and
        // leaves the flag clear so the next hover may try again.
        if (!cancelled) setFrames(null);
      }
    }, HOVER_INTENT_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, groupId, peekQuery]);

  // Advance frames only while hovered; reset to the representative on leave so
  // the grid at rest always shows the same image it showed before.
  useEffect(() => {
    if (!active || !frames || frames.length < 2) {
      setFrame(0);
      return;
    }
    const id = setInterval(
      () => setFrame((f) => (f + 1) % frames.length),
      FRAME_MS,
    );
    return () => clearInterval(id);
  }, [active, frames]);

  // Frame 0 is included (not skipped) so the wrap from the last member back to
  // it is an ordinary crossfade rather than a snap: the plain list endpoint and
  // the grouped feed both order by `_id desc`, so frames[0] is the same image,
  // same URL, as the tile's own representative thumbnail.
  const src = active && frames ? frames[frame] : null;
  return { src, total: frames?.length ?? 0, position: frame };
}
