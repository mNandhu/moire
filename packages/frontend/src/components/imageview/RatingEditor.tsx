import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { errorText } from "../../lib/api";
import { imageDocKey, patchImageEverywhere } from "../../lib/feedCache";
import { setRating as apiSetRating } from "../../lib/imageMutations";
import { ratingBadgeClass } from "../../lib/rating";
import { useToast } from "../Toasts";
import { Picker } from "../ui/Picker";

export function RatingEditor({
  id,
  docId,
  value,
  onDone,
}: {
  id: string;
  /** The id as spelled in the route: the key ImageView's doc is cached under. */
  docId: string;
  value: string;
  onDone: () => void;
}) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const v = (value || "-").trim() || "-";

  const setRating = async (next: string) => {
    if (next === v) return;
    setSaving(true);
    await queryClient.cancelQueries({ queryKey: imageDocKey(docId), exact: true });
    // Shown at once, here and on the gallery tile; undone if the write fails.
    const undo = patchImageEverywhere(queryClient, id, { rating: next }, docId);
    try {
      await apiSetRating(id, next);
      // Again on success, over any fetch that raced the write.
      patchImageEverywhere(queryClient, id, { rating: next }, docId);
      push("Rating updated", "success");
      onDone();
    } catch (e) {
      undo();
      push(`Failed to update rating: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Picker
      aria-label="Change rating"
      value={v}
      disabled={saving}
      onChange={(next) => void setRating(next)}
      options={RATING_OPTIONS}
      className="inline-block group"
      trigger={() => (
        <span
          title="Change rating"
          className={`px-3 py-1 rounded-full text-xs border flex items-center gap-1.5 transition-all duration-200 ${ratingBadgeClass(
            v,
          )} ${saving ? "opacity-50" : "group-hover:scale-[1.02] group-hover:brightness-110"}`}
        >
          <span className="font-medium">{v === "-" ? "Unrated" : v}</span>
          <ChevronDown size={12} className="opacity-70" />
        </span>
      )}
    />
  );
}

const RATING_OPTIONS = [
  { value: "-", label: "Unrated" },
  { value: "general", label: "general" },
  { value: "sensitive", label: "sensitive" },
  { value: "questionable", label: "questionable" },
  { value: "explicit", label: "explicit" },
];
