import { createContext } from "react";
import type { UndoAction } from "./undoTimeline";

/** Where an action outside the form records itself for the page's Ctrl+Z
 * (Generate provides it; elsewhere there is none). */
export const UndoActionContext = createContext<((a: UndoAction) => void) | null>(null);
