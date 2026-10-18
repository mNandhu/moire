import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { MobileNavContext } from "./components/ui/PageHeader";
import { cn } from "./lib/cn";
import { useOverlayOpen } from "./lib/backgroundLocation";
import { restoreAmbient } from "./lib/ambient";

export default function App() {
  const overlayOpen = useOverlayOpen();
  const [status, setStatus] = useState("loading");
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebar:collapsed") === "1",
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const loc = useLocation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Navigating closes the mobile drawer.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [loc.pathname]);

  // So do Escape and growing past `md` (the drawer only exists below it; left
  // open, a desktop-collapsed rail would render the expanded nav clipped).
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    const mq = window.matchMedia?.("(min-width: 768px)");
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    mq?.addEventListener?.("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      mq?.removeEventListener?.("change", onWide);
    };
  }, [mobileNavOpen]);

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
  useEffect(() => {
    const isFormField = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (el as any).isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isFormField(e.target)) return;
      // ImageView is mounted on top of the gallery, not routed in place of it,
      // so its own key handling would otherwise fire alongside this one and
      // scroll the hidden gallery underneath.
      if (overlayOpen) return;

      const scroller = scrollRef.current;
      if (!scroller) return;

      // Only handle keys that should scroll.
      const key = e.key;
      const page = Math.max(120, Math.floor(scroller.clientHeight * 0.9));
      const small = 48;

      if (key === "PageDown") {
        e.preventDefault();
        scroller.scrollBy({ top: page, behavior: "auto" });
        return;
      }
      if (key === "PageUp") {
        e.preventDefault();
        scroller.scrollBy({ top: -page, behavior: "auto" });
        return;
      }
      if (key === "Home") {
        e.preventDefault();
        scroller.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      if (key === "End") {
        e.preventDefault();
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
        return;
      }
      if (key === " " || key === "Spacebar") {
        // Space scrolls down; Shift+Space scrolls up.
        // Don't prevent default if focus is on a button (Space activates buttons).
        const active = document.activeElement as HTMLElement | null;
        if (active && active.tagName?.toLowerCase() === "button") {
          return;
        }
        e.preventDefault();
        scroller.scrollBy({ top: e.shiftKey ? -page : page, behavior: "auto" });
        return;
      }
      // Optional: arrows for consistent behavior when focus is on body
      // Only override arrow keys when the body has focus, so we don't
      // interfere with keyboard navigation in interactive controls.
      if (key === "ArrowDown" || key === "ArrowUp") {
        if (document.activeElement !== document.body) {
          return;
        }
        e.preventDefault();
        scroller.scrollBy({
          top: key === "ArrowDown" ? small : -small,
          behavior: "auto",
        });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlayOpen]);

  return (
    // Transparent, not `bg-neutral-900`: index.css paints the app's radial
    // gradients on <body>, and an opaque root covered every one of them — the
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
          <div ref={scrollRef} className="flex-1 overflow-auto">
            <Outlet />
          </div>
        </div>
      </div>
    </MobileNavContext.Provider>
  );
}
