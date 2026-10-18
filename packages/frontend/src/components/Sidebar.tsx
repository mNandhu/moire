import type { LucideIcon } from "lucide-react";
import {
  Home,
  Images,
  FolderOpen,
  Tags as TagsIcon,
  Workflow,
  Settings,
  Sparkles,
  Tag,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "../lib/cn";

type Status = string;

const NAV = [
  { section: null, items: [{ label: "Overview", path: "/overview", icon: Home }] },
  {
    section: "Library",
    items: [
      { label: "All Images", path: "/", icon: Images },
      { label: "Libraries", path: "/libraries", icon: FolderOpen },
      { label: "Tags", path: "/tags", icon: TagsIcon },
      { label: "AI Tagging", path: "/ai-tagging", icon: Sparkles },
      { label: "Rules", path: "/rules", icon: Workflow },
    ],
  },
] as const;

const STATUS_META: Record<string, { dot: string; label: string }> = {
  ok: { dot: "bg-emerald-400", label: "Connected" },
  offline: { dot: "bg-red-400", label: "Offline" },
  loading: { dot: "bg-amber-400 animate-pulse", label: "Connecting…" },
};

export function Sidebar({
  current,
  onNavigate,
  status = "loading",
  collapsed = false,
  onToggle,
}: {
  current: string;
  onNavigate: (path: string) => void;
  status?: Status;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.loading;

  const NavButton = ({
    label,
    path,
    icon: Icon,
  }: {
    label: string;
    path: string;
    icon: LucideIcon;
  }) => {
    const active = current === path;
    return (
      <button
        onClick={() => onNavigate(path)}
        aria-current={active ? "page" : undefined}
        title={collapsed ? label : undefined}
        className={cn(
          "relative w-full flex items-center gap-3 rounded-lg text-sm transition-colors",
          collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2",
          active
            ? "bg-raised text-neutral-50 font-medium"
            : "text-muted hover:bg-raised/60 hover:text-neutral-100",
        )}
      >
        {active && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-full bg-brand-400" />
        )}
        <Icon size={18} />
        {!collapsed && <span className="truncate">{label}</span>}
      </button>
    );
  };

  return (
    <aside className="h-dvh w-full border-r border-line bg-surface flex flex-col overflow-hidden">
      {/* Brand */}
      <div
        className={cn(
          "h-16 flex items-center border-b border-line select-none",
          collapsed ? "justify-center px-0" : "px-4 gap-2.5",
        )}
      >
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-brand-600 text-white shrink-0">
          <Tag size={17} strokeWidth={2.25} />
        </span>
        {!collapsed && (
          <span className="text-base font-semibold tracking-tight text-neutral-50">
            Tagify
          </span>
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

      {/* Footer */}
      <div className="px-3 py-3 border-t border-line space-y-1">
        <NavButton label="Settings" path="/settings" icon={Settings} />

        {onToggle && (
          <button
            onClick={onToggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "w-full flex items-center gap-3 rounded-lg text-sm text-muted hover:bg-raised/60 hover:text-neutral-100 transition-colors",
              collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
            {!collapsed && <span>Collapse</span>}
          </button>
        )}

        {!collapsed ? (
          <div
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-faint"
            title={`Backend: ${status}`}
          >
            <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
            <span>Backend</span>
            <span className="ml-auto text-faint">{meta.label}</span>
          </div>
        ) : (
          <div
            className="flex justify-center py-1.5"
            title={`Backend: ${meta.label}`}
          >
            <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
          </div>
        )}
      </div>
    </aside>
  );
}
