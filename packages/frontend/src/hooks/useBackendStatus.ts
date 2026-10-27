import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** The backend's health status: "loading" until it answers, "offline"
 * (asked again every few seconds) while it can't be reached. */
export function useBackendStatus(): string {
  const { data, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ status: string }>("/api/v1/health"),
    retry: false,
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.status === "error" ? 5000 : false),
  });
  if (isError) return "offline";
  return data?.status ?? "loading";
}
