import React, { createContext, useContext } from "react";
import { cn } from "../../lib/cn";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { MoireMark } from "./Logo";

/**
 * How wide a page's content runs. Forms and lists read best capped; browsers
 * (tags, rules) want more room; the gallery uses every pixel. Header and body
 * share the same cap so the title lines up with the content under it.
 */
export type PageWidth = "narrow" | "wide" | "full";

const WIDTH: Record<PageWidth, string> = {
  narrow: "max-w-5xl",
  wide: "max-w-screen-2xl",
  full: "",
};

/** Opens the off-canvas sidebar on small screens. Null outside the app shell
 * (pages rendered alone in tests), which simply hides the menu button. */
export const MobileNavContext = createContext<(() => void) | null>(null);

/**
 * Per-page title bar: one 64px row (the sidebar's brand row is the same
 * height, so the two borders meet in one line) holding the title, an optional
 * count and one-line description, an optional inline toolbar, and actions.
 */
export function PageHeader({
  title,
  count,
  countLabel,
  description,
  actions,
  width = "narrow",
  sticky = true,
  className,
  children,
}: {
  title: React.ReactNode;
  count?: number;
  /** Qualifier rendered after the count, e.g. "loaded" for a paged feed whose
   * total isn't known. Without it a growing number reads as a wrong total. */
  countLabel?: string;
  /** One quiet line beside the title. Only where it explains something the
   * title doesn't. Not a slogan. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  width?: PageWidth;
  /** Pin to the top of the scroller. Off when a parent owns the sticky band. */
  sticky?: boolean;
  className?: string;
  /** Inline toolbar between title and actions (e.g. the gallery search). */
  children?: React.ReactNode;
}) {
  // Plain-string titles also name the browser tab; every routed page has one.
  useDocumentTitle(typeof title === "string" ? title : null);
  const openNav = useContext(MobileNavContext);

  return (
    <header
      className={cn(
        sticky &&
          "sticky top-0 z-10 bg-canvas/40 backdrop-blur-md border-b border-line",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto min-h-16 px-4 md:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2",
          WIDTH[width],
        )}
      >
        {/* Phones have no sidebar to show the brand: the mark is the menu
            button, as it is the expand button of the collapsed sidebar. */}
        {openNav && (
          <button
            type="button"
            onClick={openNav}
            aria-label="Open navigation"
            title="Menu"
            className="md:hidden -ml-1.5 p-1 rounded-lg hover:bg-raised"
          >
            <MoireMark size={26} />
          </button>
        )}
        {/* Phones: the title takes what the actions leave and truncates,
            instead of pushing them onto a row of their own. */}
        <div className="min-w-0 max-md:flex-1 flex items-baseline gap-2.5">
          <h1 className="text-lg font-semibold text-neutral-50 truncate">
            {title}
          </h1>
          {typeof count === "number" && (
            <span className="text-sm text-faint tabular-nums shrink-0">
              {count.toLocaleString()}
              {countLabel && <span className="ml-1">{countLabel}</span>}
            </span>
          )}
          {description && (
            <p className="hidden lg:block text-sm text-faint truncate">
              {description}
            </p>
          )}
        </div>
        {children && (
          <div className="order-last basis-full md:order-none md:basis-auto md:flex-1 min-w-0">
            {children}
          </div>
        )}
        {actions && (
          // Never wider than the row: on a row of their own (a phone), long
          // actions wrap inside it instead of widening the page.
          <div className="ml-auto flex items-center gap-2 shrink-0 max-w-full min-w-0">{actions}</div>
        )}
      </div>
    </header>
  );
}

/** The content area under a PageHeader, capped to the same width. */
export function PageBody({
  width = "narrow",
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto px-4 md:px-6 py-6", WIDTH[width], className)}>
      {children}
    </div>
  );
}
