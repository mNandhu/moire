import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** The backend's health status, checked once: "loading" until it answers,
 * "offline" when it can't be reached. */
export function useBackendStatus(): string {
  const { data, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ status: string }>("/api/v1/health"),
    retry: false,
    staleTime: Infinity,
  });
  if (isError) return "offline";
  return data?.status ?? "loading";
}
