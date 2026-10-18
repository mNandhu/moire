import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./ui/Button";

/**
 * Gallery zoom: fewer, larger tiles or more, smaller ones.
 *
 * The grid was previously capped at four columns by fixed Tailwind breakpoints,
 * so a 2560px display showed four ~600px thumbnails; fine for looking at one
 * picture, useless for scanning a library of tens of thousands. Density is the
 * control that makes the same screen show 40 tiles or 8.
 */
export function DensityControl({
  onZoomIn,
  onZoomOut,
  atMin,
  atMax,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** At the largest tile size; can't zoom in further. */
  atMin: boolean;
  /** At the smallest tile size; can't zoom out further. */
  atMax: boolean;
}) {
  return (
    <div className="flex items-center rounded-lg border border-line bg-raised overflow-hidden shrink-0">
      <Button
        size="icon"
        variant="ghost"
        className="rounded-none border-0"
        onClick={onZoomOut}
        disabled={atMax}
        aria-label="Smaller thumbnails"
        title="Smaller thumbnails (-)"
      >
        <ZoomOut size={17} />
      </Button>
      <span className="w-px self-stretch bg-line" aria-hidden="true" />
      <Button
        size="icon"
        variant="ghost"
        className="rounded-none border-0"
        onClick={onZoomIn}
        disabled={atMin}
        aria-label="Larger thumbnails"
        title="Larger thumbnails (+)"
      >
        <ZoomIn size={17} />
      </Button>
    </div>
  );
}
