import type { LucideIcon } from "lucide-react";
import {
  Home,
  Images,
  FolderOpen,
  Tags as TagsIcon,
  Workflow,
  Settings,
  Sparkles,
  PanelLeftClose,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/cn";
import { MoireMark } from "./ui/Logo";

type Status = string;

// Browse first (where the images are), then the places you manage them.
const NAV = [
  {
    section: null,
    items: [
      { label: "Overview", path: "/overview", icon: Home },
      { label: "All Images", path: "/", icon: Images },
      { label: "Tags", path: "/tags", icon: TagsIcon },
    ],
  },
  {
    section: "Manage",
    items: [
      { label: "Libraries", path: "/libraries", icon: FolderOpen },
      { label: "AI Tagging", path: "/ai-tagging", icon: Sparkles },
      { label: "Rules", path: "/rules", icon: Workflow },
    ],
  },
] as const;

export function Sidebar({
  status = "loading",
  collapsed = false,
  onToggle,
}: {
  status?: Status;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const NavButton = ({
    label,
    path,
    icon: Icon,
  }: {
    label: string;
    path: string;
    icon: LucideIcon;
  }) => {
    // A real link: opens in a new tab on middle/ctrl-click and shows its
    // URL on hover. `end` so "/" (All Images) isn't active on every route.
    return (
      <NavLink
        to={path}
        end
        title={collapsed ? label : undefined}
        className={({ isActive }) =>
          cn(
            "relative w-full flex items-center gap-3 rounded-lg text-sm transition-colors",
            collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2",
            isActive
              ? "bg-raised text-neutral-50 font-medium"
              : "text-muted hover:bg-raised/60 hover:text-neutral-100",
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-full bg-brand-400" />
            )}
            <Icon size={18} />
            {!collapsed && <span className="truncate">{label}</span>}
          </>
        )}
      </NavLink>
    );
  };

  return (
    <aside className="h-dvh w-full bg-sunken shadow-rail flex flex-col overflow-hidden">
      {/* Brand: same 64px height and border as every page header, so the
          two read as one line across the app. Collapsed, the mark itself
          is the expand control. */}
      <div
        className={cn(
          // box-content: 64px of row plus the 1px border, exactly like the
          // page header (min-h-16 inside, border on the outer element).
          "h-16 box-content shrink-0 flex items-center border-b border-line select-none",
          collapsed ? "justify-center px-0" : "pl-4 pr-2 gap-2.5",
        )}
      >
        {collapsed && onToggle ? (
          <button
            onClick={onToggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="p-1.5 rounded-lg hover:bg-raised/60"
          >
            <MoireMark size={28} />
          </button>
        ) : (
          <MoireMark size={28} />
        )}
        {!collapsed && (
          <>
            <span className="text-lg font-semibold text-neutral-50">Moiré</span>
            {onToggle && (
              <button
                onClick={onToggle}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                className="ml-auto hidden md:inline-flex p-1.5 rounded-lg text-faint hover:text-neutral-100 hover:bg-raised/60 transition-colors"
              >
                <PanelLeftClose size={18} />
              </button>
            )}
          </>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {NAV.map((group, gi) => (
          <div key={gi} className="space-y-1">
            {group.section && !collapsed && (
              <div className="px-3 mb-1 text-xs font-medium text-faint">
                {group.section}
              </div>
            )}
            {group.section && collapsed && gi > 0 && (
              <div className="mx-2 mb-2 border-t border-line" />
            )}
            {group.items.map((it) => (
              <NavButton key={it.path} {...it} />
            ))}
          </div>
        ))}
      </nav>

      {/* Footer. The backend only earns a line when something is wrong:
          a permanent "Connected" is noise. */}
      <div className="px-3 py-3 border-t border-line space-y-1">
        {status === "offline" && (
          <div
            className={cn(
              "flex items-center gap-2 py-1.5 text-xs text-red-300",
              collapsed ? "justify-center" : "px-3",
            )}
            title="Can't reach the Moiré backend"
            role="status"
          >
            <span className="h-2 w-2 rounded-full bg-red-400 shrink-0" />
            {!collapsed && <span>Backend offline</span>}
          </div>
        )}
        <NavButton label="Settings" path="/settings" icon={Settings} />
      </div>
    </aside>
  );
}
