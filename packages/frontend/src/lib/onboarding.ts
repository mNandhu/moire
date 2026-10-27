// First-run setup: the flag that decides whether the app opens on the welcome
// page, and the pure rules the setup steps follow (which paths may go in the
// folder list, which libraries Continue creates, the tagging time estimate).

import { api, apiJson } from "./api";
import type { DiscoverSource } from "./libraryPlan";

export type OnboardingStatus = "pending" | "done" | "skipped";

export type OnboardingInfo = {
  status: OnboardingStatus;
  version: string;
  /** Where Moiré keeps its database and thumbnails. */
  data_dir: string;
  /** The machine the server runs on: folder paths are read there. */
  host: string;
  /** Running from a source checkout rather than an installed copy. */
  checkout: boolean;
};

export const ONBOARDING_KEY = ["onboarding"] as const;

export const fetchOnboarding = (signal?: AbortSignal) =>
  api<OnboardingInfo>("/api/v1/onboarding", { signal });

export const putOnboarding = (status: OnboardingStatus) =>
  apiJson<{ status: OnboardingStatus }>("/api/v1/onboarding", "PUT", { status });

/** Set once by setup, cleared when the gallery has shown the "?" hint. */
export const SHORTCUT_HINT_KEY = "onboarding:shortcut-hint";

/** The browser is on another machine than the server, so typed paths name
 * folders over there. */
export function isRemote(hostname: string): boolean {
  return !["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(hostname);
}

/** A typed or pasted path without the quotes Explorer's "Copy as path" adds. */
export function cleanPath(raw: string): string {
  let p = raw.trim();
  while (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p[p.length - 1] === p[0]) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

/** A drive (`C:\`, `C:/`), a POSIX root (`/`) or a share (`\\server`). */
const isFullPath = (p: string) => /^([a-z]:[\\/]|\/|\\\\)/i.test(p);

/** One spelling per folder, for comparing: forward slashes, no trailing
 * slash, and case folded for Windows paths (their file systems ignore it). */
export function pathKey(p: string): string {
  const windows = /^[a-z]:|^\\\\/i.test(p);
  let k = p.replace(/\\/g, "/");
  if (k.length > 1) k = k.replace(/\/+$/, "") || "/";
  return windows ? k.toLowerCase() : k;
}

const within = (child: string, parent: string) =>
  child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/**
 * Why `path` can't go in the folder list, or null when it can. Only what can
 * be told without the disk; whether the folder is there is the server's call.
 */
export function pathProblem(path: string, listed: string[]): string | null {
  if (!isFullPath(path)) {
    return "Enter the full path, starting from the drive or /, like C:\\ComfyUI\\output.";
  }
  const k = pathKey(path);
  for (const other of listed) {
    const o = pathKey(other);
    if (o === k) return "That folder is already in the list.";
    if (within(k, o)) return `That folder is inside ${other}, which is already in the list.`;
    if (within(o, k)) return `That folder holds ${other}, which is already in the list. Remove it first.`;
  }
  return null;
}

/** The reason a checked folder can't be added, from its discover report. */
export function sourceProblem(s: DiscoverSource): string | null {
  if (!s.ok) {
    return s.error === "Not an absolute path"
      ? "Enter the full path, starting from the drive or /."
      : "Moiré can't open that folder. Check the path, and that the drive is connected.";
  }
  const blocked = s.candidates.find((c) => c.status === "registered" || c.status === "overlap");
  if (blocked && s.candidates.every((c) => c.status === "registered" || c.status === "overlap")) {
    return blocked.status === "registered"
      ? "That folder is already a library."
      : `That folder overlaps the library at ${blocked.conflict_path}.`;
  }
  return null;
}

/**
 * The libraries Continue creates from the checked folders: every new
 * candidate, empty ones included (a fresh ComfyUI output folder has nothing
 * in it yet), except hidden subfolders and ones that clash with a library.
 */
export function librariesToAdd(sources: DiscoverSource[]): { path: string; name: string }[] {
  return sources
    .filter((s) => s.ok)
    .flatMap((s) => s.candidates)
    .filter((c) => (c.status === "new" || c.status === "empty") && !c.hidden)
    .map((c) => ({ path: c.path, name: c.name }));
}

/** Images and libraries a checked folder adds, for its row and the step summary. */
export function sourceTotals(s: DiscoverSource): { images: number; capped: boolean; libraries: number } {
  const cs = s.candidates.filter((c) => (c.status === "new" || c.status === "empty") && !c.hidden);
  return {
    images: cs.reduce((n, c) => n + c.image_count, 0),
    capped: cs.some((c) => c.count_capped),
    libraries: cs.length,
  };
}

// Measured rates (docs/perf-findings.md): ~0.6 images/s in a real CPU job,
// ~0.1 s an image on a GTX 1650.
export const CPU_SECONDS_PER_IMAGE = 1 / 0.6;
export const GPU_SECONDS_PER_IMAGE = 0.1;


/** How to switch to the GPU build, for the way this copy was installed. */
export function gpuInstallCommand(checkout: boolean): string {
  return checkout
    ? "UV_NO_GROUP=cpu uv --directory packages/backend sync --group gpu"
    : 'uv tool install --reinstall "moire-studio[gpu]"';
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * What Continue must do to make the libraries match the folder list: remove
 * the ones created on an earlier Continue that have since left the list, and
 * add the wanted ones not created yet. `created` maps path to library id.
 */
export function planLibrarySync(
  created: Record<string, string>,
  want: { path: string; name: string }[],
): { remove: [path: string, id: string][]; add: { path: string; name: string }[] } {
  const wanted = new Set(want.map((w) => w.path));
  return {
    remove: Object.entries(created).filter(([path]) => !wanted.has(path)),
    add: want.filter((w) => !created[w.path]),
  };
}
