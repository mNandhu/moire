import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { getBackgroundLocation } from "@/lib/backgroundLocation";
import { contextPage, getViewContext } from "@/lib/viewContext";
import { parseFilters, serializeFilters } from "@/features/images/lib/imageFilter";
import { useHotkeys } from "@/hooks/useHotkeys";
import { IMAGE } from "@/lib/shortcuts";

// The image view's own code loads in a chunk of its own (app/RootRoutes):
// this file is what the main bundle holds of it, so it imports nothing heavy.

/** Round controls floating over the image stage (back, details, prev/next). */
export const OVERLAY_BTN =
  "p-2 rounded-full bg-black/45 border border-white/10 text-white/80 hover:text-white hover:bg-black/65 disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150";

/**
 * What the view was opened under, beside Back, as a breadcrumb: the page it
 * was opened on, dimmed, then the context ("Discover / Top rated"; see
 * lib/viewContext). Bare text, shadowed to read over any image; it stops
 * short of the far corner's control, the context giving way first. The
 * page's name goes back to it, as Back does (`onBack`).
 */
export function ViewContext({ onBack }: { onBack: () => void }) {
  const location = useLocation();
  const label = getViewContext(location);
  if (!label) return null;
  const page = contextPage(getBackgroundLocation(location)?.pathname);
  return (
    <div
      role="note"
      aria-label="Viewing"
      className="pointer-events-none absolute top-4 left-[4.25rem] z-50 flex h-[42px] max-w-[calc(100%-8.5rem)] items-center gap-1.5 text-[15px] [text-shadow:0_1px_2px_rgb(0_0_0/0.6),0_0_12px_rgb(0_0_0/0.45)]"
    >
      {page && (
        <>
          <button
            type="button"
            onClick={onBack}
            className="pointer-events-auto shrink-0 rounded-sm text-white/55 transition-colors duration-150 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            {page}
          </button>
          <span aria-hidden className="shrink-0 text-white/35">
            /
          </span>
        </>
      )}
      <span className="truncate font-medium text-white/90">{label}</span>
    </div>
  );
}

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
      <ViewContext onBack={close} />
      <Loader2 className="animate-spin text-muted" aria-label="Loading" />
    </div>
  );
}
