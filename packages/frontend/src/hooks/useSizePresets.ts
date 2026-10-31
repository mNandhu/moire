import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** A size preset and how many images have its shape (`GET /images/sizes`). */
export type SizePreset = {
  shape: string;
  width: number;
  height: number;
  orientation: "portrait" | "square" | "landscape";
  count: number;
};

const NO_SIZES: SizePreset[] = [];

export const IMAGE_SIZES_KEY = ["image-sizes"] as const;

/** The size presets with library counts; shared with the Generate size picker. */
export function useSizePresets(): SizePreset[] {
  const { data = NO_SIZES } = useQuery({
    queryKey: IMAGE_SIZES_KEY,
    queryFn: ({ signal }) => api<SizePreset[]>(`/api/v1/images/sizes`, { signal }),
  });
  return data;
}
