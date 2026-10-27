import { useQuery } from "@tanstack/react-query";
import { FACES_KEY, fetchFaces, isFacesBusy } from "../lib/ai";

/** Poll `/api/v1/ai/faces`: every second while the face model downloads or
 * avatars wait, otherwise once. */
export function useFaceStatus() {
  return useQuery({
    queryKey: FACES_KEY,
    queryFn: ({ signal }) => fetchFaces(signal),
    refetchInterval: (q) => (isFacesBusy(q.state.data) ? 1000 : false),
  });
}
