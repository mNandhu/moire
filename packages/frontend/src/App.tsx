import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useHotkeys } from "./hooks/useHotkeys";
import { Sidebar } from "./components/Sidebar";
import { SearchPalette } from "./components/SearchPalette";
import { PageErrorBoundary } from "./components/ErrorScreen";
import { MobileNavContext } from "./components/ui/PageHeader";
import { cn } from "./lib/cn";
import { restoreAmbient } from "./lib/ambient";
import { useQueueTitle } from "./hooks/useQueueTitle";
import { usePrefetchCharacters } from "./components/ImageCharacters";

export default function App() {
  useQueueTitle();
  usePrefetchCharacters();
  const [status, setStatus] = useState("loading");
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebar:collapsed") === "1",
  );
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
  useHotkeys([{ keys: ["Escape"], mods: "any", run: () => setMobileNavOpen(false) }], {
    enabled: mobileNavOpen,
    overlay: "ignore",
    fields: true,
  });
  useEffect(() => {
    if (!mobileNavOpen) return;
    const mq = window.matchMedia?.("(min-width: 768px)");
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileNavOpen(false);
    };
    mq?.addEventListener?.("change", onWide);
    return () => mq?.removeEventListener?.("change", onWide);
  }, [mobileNavOpen]);

  // Ctrl/Cmd+K opens the search from anywhere, a text field or a dialog
  // included; again closes it. Capture phase, ahead of a dialog's key trap.
  useHotkeys(
    [
      {
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
    localStorage.setItem("sidebar:collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    restoreAmbient();
  }, []);

  useEffect(() => {
    fetch("/api/v1/health")
      .then(async (r) => setStatus((await r.json()).status))
      .catch(() => setStatus("offline"));
  }, []);

  // Enable keyboard scrolling (PageDown/PageUp/Home/End/Space) for the main scroll container.
  // The app scrolls inside an overflow div, so default PageDown on window does nothing.
  // ImageView is mounted on top of the gallery, not routed in place of it, so
  // its own key handling would otherwise fire alongside this one and scroll
  // the hidden gallery underneath (useHotkeys bails while an overlay is open).
  const scrollBy = (e: KeyboardEvent, top: number) => {
    e.preventDefault();
    scrollRef.current?.scrollBy({ top, behavior: "auto" });
  };
  const pageSize = () => Math.max(120, Math.floor((scrollRef.current?.clientHeight ?? 0) * 0.9));
  useHotkeys([
    { keys: ["PageDown"], run: (e) => scrollBy(e, pageSize()) },
    { keys: ["PageUp"], run: (e) => scrollBy(e, -pageSize()) },
    // Ctrl/Cmd+Home/End mean top/bottom too; other combos stay the browser's.
    {
      keys: ["Home"],
      mods: "ctrl",
      run: (e) => {
        e.preventDefault();
        scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      },
    },
    {
      keys: ["End"],
      mods: "ctrl",
      run: (e) => {
        e.preventDefault();
        const scroller = scrollRef.current;
        scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      },
    },
    {
      keys: [" ", "Spacebar"],
      run: (e) => {
        // Space scrolls down; Shift+Space scrolls up.
        // Don't prevent default if focus is on a button (Space activates buttons).
        const active = document.activeElement as HTMLElement | null;
        if (active && active.tagName?.toLowerCase() === "button") return;
        scrollBy(e, e.shiftKey ? -pageSize() : pageSize());
      },
    },
    // Arrows for consistent behavior when focus is on body. Only override them
    // when the body has focus, so we don't interfere with keyboard navigation
    // in interactive controls.
    {
      keys: ["ArrowDown", "ArrowUp"],
      run: (e) => {
        if (document.activeElement !== document.body) return;
        scrollBy(e, e.key === "ArrowDown" ? 48 : -48);
      },
    },
  ]);

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
