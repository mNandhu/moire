import { useContext, useRef, type ReactNode } from "react";
import { UNSAFE_LocationContext as LocationContext, UNSAFE_RouteContext as RouteContext } from "react-router-dom";

type Held = {
  key: string;
  location: React.ContextType<typeof LocationContext>;
  route: React.ContextType<typeof RouteContext>;
};

/**
 * Hands its subtree the router's location and route context as they were
 * while the location stays the same entry (path, search, hash and key),
 * instead of the new objects `<Routes>` makes on every render. With the
 * image view open over the gallery, each step navigates; the gallery's
 * location is the background one, whose key never changes (`<Routes>` gives
 * a plain location the key "default"), yet every router hook under it
 * re-rendered the whole page per step. Any real navigation has a new key,
 * so it still reaches the subtree, `state` included.
 */
export function HoldRoute({ children }: { children: ReactNode }) {
  const location = useContext(LocationContext);
  const route = useContext(RouteContext);
  const { pathname, search, hash, key: entry } = location.location;
  const key = `${entry} ${pathname}${search}#${hash}`;
  const held = useRef<Held | null>(null);
  if (held.current?.key !== key) held.current = { key, location, route };
  return (
    <LocationContext.Provider value={held.current.location}>
      <RouteContext.Provider value={held.current.route}>{children}</RouteContext.Provider>
    </LocationContext.Provider>
  );
}
