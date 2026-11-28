import type { Location } from "react-router-dom";

/**
 * What an opened image is being looked at under ("Top rated", a character,
 * the gallery's filters), named by the page that opened it and shown in the
 * image view's corner. It rides in the history `state` beside
 * `backgroundLocation`, so stepping to the next image (which carries the
 * state forward) and a reload keep it; a pasted link has none.
 */
type StateWithContext = { context?: unknown } | null | undefined;

/** The history `state` naming the context; nothing for no name. */
export const contextState = (label: string | undefined): { context?: string } =>
  label ? { context: label } : {};

/** `state` without its context: for a step off what it names (to one of
 * the image's batch-mates, which needn't be top rated or the character). */
export function withoutContext<S>(state: S): S {
  if (!state || typeof state !== "object" || !("context" in state)) return state;
  const rest: Record<string, unknown> = { ...state };
  delete rest.context;
  return rest as S;
}

// The pages an image opens over with a context, by path, as the sidebar
// names them. A character's page is under Characters, a tag's under Tags.
const PAGES: readonly [RegExp, string][] = [
  [/^\/$/, "All Images"],
  [/^\/overview\/?$/, "Overview"],
  [/^\/discover\/?$/, "Discover"],
  [/^\/characters\//, "Characters"],
  [/^\/tags(\/|$)/, "Tags"],
];

/** The page at `pathname` as the context's breadcrumb names it ("Discover"),
 * if it is one that names a context. */
export function contextPage(pathname: string | undefined): string | undefined {
  return pathname ? PAGES.find(([re]) => re.test(pathname))?.[1] : undefined;
}

/** The context the image view was opened under, if the opener named one. */
export function getViewContext(location: Pick<Location, "state">): string | undefined {
  const context = (location.state as StateWithContext)?.context;
  return typeof context === "string" && context ? context : undefined;
}
