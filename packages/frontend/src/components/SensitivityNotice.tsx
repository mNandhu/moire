import { useState } from "react";
import { X } from "lucide-react";
import { errorText } from "../lib/api";
import { postTagUntagged } from "../lib/ai";
import { useSensitivity } from "../lib/queries/sensitivity";
import { unknownHidden } from "../lib/sensitivity";
import { useToast } from "./Toasts";
import { Button } from "./ui/Button";

const DISMISSED = "moire.sensitivity.unknown-dismissed";

/** While the sensitivity filter is on: how many images it hides for having
 * no level yet, and the AI tagging that gives them one. `dismissible` (the
 * gallery) hides it for the rest of the session. */
export function UnknownHiddenNotice({ dismissible = false }: { dismissible?: boolean }) {
  const { data } = useSensitivity();
  const { push } = useToast();
  const [queueing, setQueueing] = useState(false);
  const [dismissed, setDismissed] = useState(() => dismissible && sessionStorage.getItem(DISMISSED) === "1");
  const unknown = unknownHidden(data);
  if (!unknown || dismissed) return null;

  const tag = async () => {
    setQueueing(true);
    try {
      const r = await postTagUntagged(unknown, undefined, { unknown: true });
      push(
        r.queued ? `Queued AI tagging for ${r.queued.toLocaleString()} images` : "Nothing left to tag",
        r.queued ? "success" : "info",
      );
    } catch (e) {
      push(`Couldn't start AI tagging: ${errorText(e)}`, "error");
    } finally {
      setQueueing(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-100"
    >
      <span>{unknown.toLocaleString()} images hidden until AI-tagged</span>
      <Button size="sm" className="ml-auto" pending={queueing} onClick={() => void tag()}>
        Tag them
      </Button>
      {dismissible && (
        <Button
          size="iconSm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => {
            sessionStorage.setItem(DISMISSED, "1");
            setDismissed(true);
          }}
        >
          <X size={14} />
        </Button>
      )}
    </div>
  );
}
