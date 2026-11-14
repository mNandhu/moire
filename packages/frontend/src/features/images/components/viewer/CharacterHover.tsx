import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRecipe } from "@/features/generate/lib/generate";
import { identityNames } from "@/features/images/lib/identityHighlight";

/** A character pointed at: their tag and accent colour (CharacterEntry.color). */
type Pointed = { tag: string; color: string | null };
type HoverState = { pointed: Pointed | null; set: (pointed: Pointed | null) => void };

const Hover = createContext<HoverState>({ pointed: null, set: () => {} });

// Without a colour of their own, the app's accent (brand-400).
const FALLBACK = "#9d88f0";

/** A pointed-at character's identity tag names and the colour to mark them in. */
export type HoveredIdentity = { names: ReadonlySet<string>; color: string };

/** The fill of a marked tag: the colour, see-through enough to read over. */
export const identityFill = (color: string) => `color-mix(in srgb, ${color} 40%, transparent)`;

/** The character pointed at in the viewer's side panel, shared with the
 * Generation and Tags tabs so they can light up that character's tags. */
export function CharacterHoverProvider({ children }: { children: ReactNode }) {
  const [pointed, set] = useState<Pointed | null>(null);
  const value = useMemo(() => ({ pointed, set }), [pointed]);
  return <Hover.Provider value={value}>{children}</Hover.Provider>;
}

/** Sets (or, with null, clears) the character pointed at. */
export const useSetHoveredCharacter = () => useContext(Hover).set;

/** The pointed-at character's identity tags (features/images/lib/identityHighlight) and their
 * colour, or null while none is pointed at or their recipe is on its way. */
export function useHoveredIdentity(): HoveredIdentity | null {
  const { pointed } = useContext(Hover);
  const { data } = useRecipe(pointed?.tag ?? null);
  return useMemo(
    () => (pointed && data ? { names: identityNames(data), color: pointed.color ?? FALLBACK } : null),
    [pointed, data],
  );
}
