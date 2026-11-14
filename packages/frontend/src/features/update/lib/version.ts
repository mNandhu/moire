import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiJson } from "@/lib/api";

/** GET /api/v1/version: this version, and the newest on PyPI when newer. */
export type VersionStatus = {
  current: string;
  latest: string | null;
  update_available: boolean;
  release_url: string | null;
  /** The upgrade command for how this copy was installed (none in a checkout). */
  command: string | null;
  install_kind: "checkout" | "docker" | "uv" | "pipx" | "pip";
  /** Checking can happen here at all (not a checkout, not off by env). */
  can_check: boolean;
  /** The user's switch in Settings > About. */
  enabled: boolean;
  /** Unix seconds of the last answer from PyPI. */
  checked_at: number | null;
};

const VERSION_KEY = ["version"] as const;

/** The server asks PyPI once a day; an open tab re-reads hourly to hear of it. */
export function useVersionStatus() {
  return useQuery({
    queryKey: VERSION_KEY,
    queryFn: ({ signal }) => api<VersionStatus>("/api/v1/version", { signal }),
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });
}

export function useSetUpdateCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => apiJson<VersionStatus>("/api/v1/version", "PUT", { enabled }),
    onSuccess: (s) => qc.setQueryData(VERSION_KEY, s),
  });
}

export function useCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiJson<VersionStatus>("/api/v1/version/check", "POST"),
    onSuccess: (s) => qc.setQueryData(VERSION_KEY, s),
  });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". Pure. */
export function checkedAgo(checkedAt: number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, now - checkedAt);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}
