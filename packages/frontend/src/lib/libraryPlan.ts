// The Add Library dry run: types for `POST /libraries/discover` and the small
// decisions the dialog makes about them (which paths the user typed, which
// candidates start ticked). Pure, so the plan rules are testable.

import { apiJson } from "./api";

type CandidateStatus = "new" | "registered" | "overlap" | "empty";

export type LibraryCandidate = {
  path: string;
  name: string;
  source: string;
  image_count: number;
  count_capped: boolean;
  hidden: boolean;
  status: CandidateStatus;
  note: string | null;
  conflict_path: string | null;
};

export type DiscoverSource = {
  path: string;
  ok: boolean;
  error: string | null;
  subdir_count: number;
  loose_image_count: number;
  fell_back_to_root: boolean;
  candidates: LibraryCandidate[];
};

export function discoverLibraries(
  paths: string[],
  splitSubdirs: boolean,
): Promise<{ sources: DiscoverSource[] }> {
  return apiJson(`/api/v1/libraries/discover`, "POST", { paths, split_subdirs: splitSubdirs });
}

/** One folder per line (also accepts `;`-separated); blank lines and repeats dropped. */
export function parsePathList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\r\n;]+/)) {
    const p = raw.trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Can this candidate be added at all? Already-registered folders can't. */
export function isSelectable(c: LibraryCandidate): boolean {
  return c.status !== "registered";
}

/**
 * Ticked by default: new folders with images that aren't hidden. Empty, hidden
 * and overlapping folders stay selectable but opt-in; overlaps index the same
 * images twice, which is rarely what anyone wants.
 */
export function defaultSelected(c: LibraryCandidate): boolean {
  return c.status === "new" && !c.hidden;
}

export function formatCount(c: Pick<LibraryCandidate, "image_count" | "count_capped">): string {
  // Capped at zero means the overall time budget ran out before this folder.
  if (c.count_capped && c.image_count === 0) return "not counted";
  const n = c.image_count.toLocaleString();
  return c.count_capped ? `${n}+ images` : `${n} image${c.image_count === 1 ? "" : "s"}`;
}
