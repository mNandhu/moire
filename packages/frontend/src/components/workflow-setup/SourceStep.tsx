import { useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { ButtonLink } from "../ui";
import { cn } from "../../lib/cn";
import type { GeneratorSourceIn } from "../../lib/generate";

/** Where a new workflow comes from: an Export (API) file, or a workflow
 * family from the extraction rules. */
export function SourceStep({ onSource, error }: { onSource: (s: GeneratorSourceIn) => void; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const read = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    try {
      onSource({ graph: JSON.parse(await file.text()), filename: file.name });
    } catch {
      setReadError(`${file.name} isn't JSON`);
    }
  };
  const shown = readError ?? error;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void read(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-3 rounded-xl border-[1.5px] border-dashed px-4 py-10 text-center",
          drag ? "border-brand-500 bg-brand-900/20" : "border-line-strong",
        )}
      >
        <FileUp size={22} className="text-muted" />
        <span className="text-sm text-neutral-100">Drop an Export (API) file</span>
        <span className="inline-flex h-8 items-center rounded-lg border border-line bg-raised px-3 text-xs">Choose file</span>
        <input ref={input} type="file" accept=".json,application/json" className="sr-only" onChange={(e) => void read(e.target.files?.[0])} />
      </label>
      {shown && (
        <div role="alert" className="rounded-lg border border-red-800/70 bg-red-950/30 px-3.5 py-3 text-sm text-red-200">
          {shown}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="text-center">
        <ButtonLink to="/rules" size="sm">
          Pick a workflow from your images
        </ButtonLink>
      </div>
    </div>
  );
}
