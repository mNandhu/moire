import { useLayoutEffect, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { BATCH_STRIP_KEY } from "../../lib/feedCache";
import { imageHref, type ImageDoc } from "../../lib/imageFilter";
import { smallThumb } from "../../lib/media";

const BATCH_STRIP_MAX = 40;

/**
 * The rest of the image's batch (same workflow, same prompt: its seeds and
 * reruns), as a strip of thumbnails. Picking one steps the viewer into the
 * batch: arrows then walk its members, like drilling into it in the gallery.
 * Nothing when the image is alone in its batch.
 */
export function BatchStrip({
  groupId,
  scope,
  currentId,
  currentThumb,
}: {
  groupId: string;
  scope: string;
  currentId: string;
  currentThumb?: string | null;
}) {
  const location = useLocation();
  const query = useMemo(() => {
    const sp = new URLSearchParams(scope);
    sp.set("group_id", groupId);
    return sp.toString();
  }, [scope, groupId]);
  const { data: fetched } = useQuery({
    queryKey: [...BATCH_STRIP_KEY, query],
    queryFn: ({ signal }) =>
      api<ImageDoc[]>(`/api/v1/images?${query}&limit=${BATCH_STRIP_MAX}`, { signal }),
    staleTime: 60_000,
  });
  // The open image is always in it, even past the members fetched.
  const members = useMemo(
    () =>
      !fetched || fetched.some((m) => m._id === currentId)
        ? fetched
        : [{ _id: currentId, thumb_url: currentThumb ?? undefined } as ImageDoc, ...fetched],
    [fetched, currentId, currentThumb],
  );
  const current = useRef<HTMLAnchorElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // The open image in view, without scrolling the panel itself; again when
  // the strip gets its width (it loads in a hidden tab too).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const centre = () => {
      const el = current.current;
      if (el && strip.clientWidth) strip.scrollLeft = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
    };
    centre();
    let width = strip.clientWidth;
    const ro = new ResizeObserver(() => {
      if (strip.clientWidth === width) return;
      width = strip.clientWidth;
      centre();
    });
    ro.observe(strip);
    return () => ro.disconnect();
  }, [members, currentId]);
  if (!members || members.length < 2) return null;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted">
        This batch{" "}
        <span className="text-faint tabular-nums">
          {fetched && fetched.length >= BATCH_STRIP_MAX ? `${BATCH_STRIP_MAX}+` : members.length}
        </span>
      </div>
      {/* Relative: the thumbs' offsetLeft is measured from it. */}
      <div ref={stripRef} className="relative -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:thin]">
        {members.map((m) => {
          const here = m._id === currentId;
          return (
            <Link
              key={m._id}
              ref={here ? current : undefined}
              to={imageHref(m._id, query)}
              // Like the arrows: in place, and still over the gallery.
              replace
              state={location.state}
              aria-current={here ? "true" : undefined}
              title={m.path?.split(/[\\/]/).pop()}
              className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-raised transition-opacity ${
                here ? "" : "opacity-70 hover:opacity-100"
              }`}
            >
              {m.thumb_url && (
                <img src={smallThumb(m.thumb_url)} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
              {here && <span className="absolute inset-0 rounded-md ring-2 ring-inset ring-brand-400" />}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
