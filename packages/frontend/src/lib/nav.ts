import type { LucideIcon } from "lucide-react";
import {
  FolderOpen,
  History,
  Home,
  Images,
  Plus,
  Settings,
  Shirt,
  Sparkles,
  Tags,
  Wand2,
  Workflow,
} from "lucide-react";

export type NavPage = { label: string; path: string; icon: LucideIcon; detail?: string };

// Browse first (where the images are), then the places you manage them.
export const NAV: { section: string | null; items: NavPage[] }[] = [
  {
    section: null,
    items: [
      { label: "Overview", path: "/overview", icon: Home },
      { label: "All Images", path: "/", icon: Images },
      { label: "Tags", path: "/tags", icon: Tags },
    ],
  },
  {
    section: "Create",
    items: [
      { label: "Generate", path: "/generate", icon: Wand2 },
      { label: "Generations", path: "/generations", icon: History },
      { label: "Outfits", path: "/outfits", icon: Shirt },
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
];

/** The sidebar's footer link. */
export const SETTINGS_PAGE: NavPage = { label: "Settings", path: "/settings", icon: Settings };

/** Every page the search can jump to: the sidebar's, then Settings, then
 * "New workflow". */
export const NAV_PAGES: NavPage[] = [
  ...NAV.flatMap((g) => g.items),
  SETTINGS_PAGE,
  { label: "New workflow", path: "/generate/workflows/new", icon: Plus, detail: "Generate" },
];
