import React from "react";
import { createPortal } from "react-dom";

/** Where a tab's actions go: the tab bar's right end (null: no bar). */
export const TabActionsSlot = React.createContext<HTMLElement | null>(null);

/** A tab's actions ("Copy all", "Remix"), drawn at the tab bar's right end,
 * or as a row of their own when the panel has no tab bar. */
export function TabActions({ children }: { children: React.ReactNode }) {
  const slot = React.useContext(TabActionsSlot);
  if (slot) return createPortal(children, slot);
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}

/** An icon-only action in a tab's action row. */
export const TAB_ACTION = "p-2 rounded-lg text-muted hover:text-white hover:bg-raised transition-colors";
