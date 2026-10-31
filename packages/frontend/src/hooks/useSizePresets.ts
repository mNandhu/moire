import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { IMAGE_SIZES_KEY } from "../lib/queries/images";

/** A size preset and how many images have its shape (`GET /images/sizes`). */
export type SizePreset = {
  shape: string;
  width: number;
  height: number;
  orientation: "portrait" | "square" | "landscape";
  count: number;
};

const NO_SIZES: SizePreset[] = [];

/** The size presets with library counts; shared with the Generate size picker.
 * `quarantined` counts the Quarantined view's images instead. */
export function useSizePresets(quarantined = false): SizePreset[] {
  const { data = NO_SIZES } = useQuery({
    queryKey: quarantined ? [...IMAGE_SIZES_KEY, "quarantined"] : IMAGE_SIZES_KEY,
    queryFn: ({ signal }) =>
      api<SizePreset[]>(`/api/v1/images/sizes${quarantined ? "?quarantined=1" : ""}`, { signal }),
  });
  return data;
}
