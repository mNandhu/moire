import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { getBackgroundLocation } from "@/lib/backgroundLocation";
import { parseFilters, serializeFilters } from "@/features/images/lib/imageFilter";
import { useHotkeys } from "@/hooks/useHotkeys";
import { IMAGE } from "@/lib/shortcuts";

// The image view's own code loads in a chunk of its own (app/RootRoutes):
// this file is what the main bundle holds of it, so it imports nothing heavy.

/** Round controls floating over the image stage (back, details, prev/next). */
export const OVERLAY_BTN =
  "p-2 rounded-full bg-black/45 border border-white/10 text-white/80 hover:text-white hover:bg-black/65 disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150";

/** Closing the image view: opened over the gallery, back to that exact
 * history entry (cheap, the gallery never unmounted) instead of pushing a
 * fresh navigation to it; opened by link, to the gallery under `filterQuery`. */
export function useCloseImageView(filterQuery: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const opened = !!getBackgroundLocation(location);
  return useCallback(() => {
    if (opened) navigate(-1);
    else navigate(`/${filterQuery ? `?${filterQuery}` : ""}`);
  }, [opened, navigate, filterQuery]);
}

/** Shown while the view's code is on the wire: the gallery's keys already
 * stand down for the overlay, so this one answers Back and Escape. */
export function ImageViewLoading() {
  const location = useLocation();
  const close = useCloseImageView(serializeFilters(parseFilters(new URLSearchParams(location.search))).toString());
  useHotkeys(
    [
      {
        ...IMAGE.back,
        run: (e) => {
          e.preventDefault();
          close();
        },
      },
    ],
    { overlay: "ignore" },
  );
  return (
    <div className="absolute inset-0 grid place-items-center">
      <button onClick={close} className={`absolute top-4 left-4 ${OVERLAY_BTN}`} aria-label="Back">
        <ArrowLeft />
      </button>
      <Loader2 className="animate-spin text-muted" aria-label="Loading" />
    </div>
  );
}
