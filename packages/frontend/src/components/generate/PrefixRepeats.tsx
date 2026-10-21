import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useToast } from "../Toasts";
import { displayWord } from "../../lib/compose";
import { prefixRepeats, withoutTerms } from "../../lib/promptRepeats";

/** Under the Prefix: the prompt's tags it already has, with a way to take
 * them out of the prompt (Undo in the toast). Closed, it stays closed for
 * those same tags. */
export function PrefixRepeats({
  prefix,
  prompt,
  onPrompt,
}: {
  prefix: string;
  prompt: string;
  onPrompt: (text: string) => void;
}) {
  const toast = useToast();
  const [closed, setClosed] = useState<string | null>(null);
  // The prompt as it stands when Undo is clicked, not when the toast opened.
  const latest = useRef(prompt);
  latest.current = prompt;
  const repeats = prefixRepeats(prefix, prompt);
  const key = repeats.join("\n").toLowerCase();
  if (!repeats.length || closed === key) return null;
  const remove = () => {
    const before = prompt;
    const { text, removed } = withoutTerms(prompt, repeats);
    onPrompt(text);
    toast.push(`Removed ${removed} ${removed === 1 ? "tag" : "tags"} from the prompt`, {
      type: "success",
      action: {
        label: "Undo",
        // Edited since: put the tags back in front rather than lose the edit.
        onClick: () => onPrompt(latest.current === text ? before : [...repeats, latest.current].filter(Boolean).join(", ")),
      },
    });
  };
  return (
    <div className="mb-1 mt-1.5 flex items-center gap-2.5 rounded-lg border border-amber-700/40 bg-amber-950/20 px-2.5 py-1.5 text-xs text-neutral-300">
      <span className="min-w-0 flex-1 truncate">
        Also in the prompt:{" "}
        {repeats.map((r, i) => (
          <span key={r}>
            {i > 0 && ", "}
            <span className="text-amber-200">{displayWord(r)}</span>
          </span>
        ))}
      </span>
      <button type="button" onClick={remove} className="shrink-0 text-brand-300 hover:text-brand-200">
        Remove from prompt
      </button>
      <button
        type="button"
        onClick={() => setClosed(key)}
        aria-label="Keep them"
        title="Keep them"
        className="shrink-0 rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
      >
        <X size={13} />
      </button>
    </div>
  );
}
