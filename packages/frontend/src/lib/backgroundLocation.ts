import { createContext, useContext } from "react";
import type { Location } from "react-router-dom";

/**
 * The only pieces `<Routes location>` reads. Deliberately not the full
 * `Location`, that also carries `state`, and stashing a whole location
 * inside another location's state would nest one layer deeper every time an
 * image is opened from the gallery.
 */
export type BackgroundLocation = Pick<Location, "pathname" | "search" | "hash">;

type StateWithBackground = { backgroundLocation?: BackgroundLocation } | null | undefined;

/** Reads `backgroundLocation` off a location's `state`, if present. */
export function getBackgroundLocation(
  location: Pick<Location, "state">,
): BackgroundLocation | undefined {
  return (location.state as StateWithBackground)?.backgroundLocation;
}

/** Builds the history `state` that pins `location` as the background. */
export function withBackgroundLocation(
  location: Pick<Location, "pathname" | "search" | "hash">,
): { backgroundLocation: BackgroundLocation } {
  return {
    backgroundLocation: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    },
  };
}

/**
 * True while ImageView is open as an overlay on top of this subtree (see
 * RootRoutes). The gallery's own global (window/document) key listeners keep
 * running even though its `<Routes>` is frozen on the background location;
 * anything that owns one must check this and bail, or it double-handles keys
 * ImageView is also acting on.
 */
export const OverlayOpenContext = createContext(false);

export function useOverlayOpen(): boolean {
  return useContext(OverlayOpenContext);
}
