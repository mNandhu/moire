import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLocalPref } from "./hooks/useLocalPref";
import { Outlet, useLocation } from "react-router-dom";
import { useHotkeys } from "./hooks/useHotkeys";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useBackendStatus } from "./hooks/useBackendStatus";
import { useShellKeyScroll } from "./hooks/useShellKeyScroll";
import { Sidebar } from "./components/Sidebar";
import { SearchPalette } from "./components/SearchPalette";
import { PageErrorBoundary } from "./components/ErrorScreen";
import { MobileNavContext } from "./components/ui/PageHeader";
import { cn } from "./lib/cn";
import { EVERYWHERE } from "./lib/shortcuts";
import { restoreAmbient } from "./lib/ambient";
import { useQueueTitle } from "./hooks/useQueueTitle";
import { usePrefetchCharacters } from "./lib/queries";

export default function App() {
  useQueueTitle();
  usePrefetchCharacters();
  const status = useBackendStatus();
  const [collapsed, setCollapsed] = useLocalPref("sidebar:collapsed", false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // A result on the same path ("/?lora=…") doesn't close the drawer, so
  // the search does.
  const openSearch = useCallback(() => {
    setMobileNavOpen(false);
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const loc = useLocation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Navigating closes the mobile drawer.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [loc.pathname]);

  // So do Escape and growing past `md` (the drawer only exists below it; left
  // open, a desktop-collapsed rail would render the expanded nav clipped).
  useHotkeys([{ ...EVERYWHERE.close, mods: "any", run: () => setMobileNavOpen(false) }], {
    enabled: mobileNavOpen,
    overlay: "ignore",
    fields: true,
  });
  const wide = useMediaQuery("(min-width: 768px)");
  useEffect(() => {
    if (wide) setMobileNavOpen(false);
  }, [wide]);

  // Ctrl/Cmd+K opens the search from anywhere, a text field or a dialog
  // included; again closes it. Capture phase, ahead of a dialog's key trap.
  useHotkeys(
    [
      {
        ...EVERYWHERE.search,
        mods: "any",
        match: (e) => {
          // The K the layout types (Dvorak's too); a non-Latin layout's key in
          // K's place.
          const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
          const isK = key === "k" || (!/^[a-z]$/.test(key) && e.code === "KeyK");
          return isK && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing;
        },
        run: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          setMobileNavOpen(false);
          setSearchOpen((v) => !v);
        },
      },
    ],
    { capture: true, fields: true, overlay: "ignore" },
  );

  useEffect(() => {
    restoreAmbient();
  }, []);

  useShellKeyScroll(scrollRef);

  return (
    // Transparent, not `bg-neutral-900`: index.css paints the app's radial
    // gradients on <body>, and an opaque root covered every one of them, the
    // designed background was in the stylesheet but had never been visible.
    <MobileNavContext.Provider value={openMobileNav}>
      <div className="h-dvh text-white">
        <div className="ambient-wash" aria-hidden="true" />
        {/* Small screens: the sidebar is an off-canvas drawer over a scrim,
            opened from the page header's menu button. */}
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
        )}
        {/* Fixed sidebar */}
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-40 md:z-20 w-60 transition-[width,transform] duration-200",
            mobileNavOpen ? "translate-x-0" : "-translate-x-full",
            "md:translate-x-0",
            collapsed && "md:w-16",
          )}
        >
          <Sidebar
            status={status}
            collapsed={collapsed && !mobileNavOpen}
            onToggle={() => setCollapsed((v) => !v)}
            onSearch={openSearch}
          />
        </div>
        {/* Main column shifted right of sidebar. Each page caps its own
            width (PageHeader/PageBody) so title and content share one edge. */}
        <div
          className={cn(
            "h-full flex flex-col transition-[margin] duration-200",
            collapsed ? "md:ml-16" : "md:ml-60",
          )}
        >
          {/* No overscroll bounce: the sticky page header lives inside this
              scroller, so rubber-banding past the top dragged the header down
              with the content. */}
          <div ref={scrollRef} className="flex-1 overflow-auto overscroll-none">
            <PageErrorBoundary resetKey={loc.pathname}>
              {/* Lazy pages (RootRoutes) load in here; the shell stays. */}
              <Suspense fallback={null}>
                <Outlet />
              </Suspense>
            </PageErrorBoundary>
          </div>
        </div>
        <SearchPalette open={searchOpen} onClose={closeSearch} />
      </div>
    </MobileNavContext.Provider>
  );
}
