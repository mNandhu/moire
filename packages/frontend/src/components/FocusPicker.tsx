import type { Face } from "../lib/character";

/**
 * An image to click: the point clicked is where an avatar or cover is
 * centred. Shows the face Moiré found (dashed) while no point is set, and
 * the set point as a ring. Sized by `height`, in the image's own shape.
 */
export function FocusPicker({
  src,
  aspect,
  face = null,
  focus,
  onChange,
  height = "h-44",
}: {
  src: string;
  aspect: number | null;
  face?: Face | null;
  focus: readonly [number, number] | null;
  onChange: (focus: [number, number]) => void;
  height?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Set the centre"
      title="Click to centre here"
      className={`relative ${height} max-w-full rounded-lg overflow-hidden bg-raised cursor-crosshair`}
      style={{ aspectRatio: aspect ?? 1 }}
      onClick={(e) => {
        // Enter / Space (no pointer position): the middle.
        if (e.detail === 0) return onChange([0.5, 0.5]);
        const r = e.currentTarget.getBoundingClientRect();
        const at = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
        onChange([at((e.clientX - r.left) / r.width), at((e.clientY - r.top) / r.height)]);
      }}
    >
      <img src={src} alt="" className="w-full h-full object-cover" />
      {face && !focus && (
        <span
          className="absolute border border-dashed border-white/80 rounded"
          style={{
            left: `${(face[0] - face[2] / 2) * 100}%`,
            top: `${(face[1] - face[3] / 2) * 100}%`,
            width: `${face[2] * 100}%`,
            height: `${face[3] * 100}%`,
          }}
        />
      )}
      {focus && (
        <span
          className="absolute h-4 w-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow"
          style={{ left: `${focus[0] * 100}%`, top: `${focus[1] * 100}%` }}
        />
      )}
    </button>
  );
}
