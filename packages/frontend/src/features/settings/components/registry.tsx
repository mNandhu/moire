import type { LucideIcon } from "lucide-react";
import { Tags, FileText, EyeOff, Wand2, UserRound, Plug, Palette, ShieldCheck, Info } from "lucide-react";
import type { ComponentType } from "react";
import { lazyPage } from "@/lib/lazyPage";

type Panels = typeof import("./panels");

/** A panel from `panels.ts`, loaded on first render (reloading once if a
 * rebuild removed the chunk). All of them share one chunk, so switching
 * tabs loads nothing more. */
const panel = (name: keyof Panels): ComponentType =>
  lazyPage(() => import("./panels").then((m) => ({ default: m[name] })));

/**
 * One settings page section: a tab + the panel it renders.
 *
 * To add a new settings section: write a `*Section` component, export it from
 * `panels.ts`, then append one entry to `SETTINGS_SECTIONS` below. The tab
 * strip, routing (`?section=<id>`) and active highlight all derive from this
 * registry.
 */
export type SettingsSection = {
  /** URL slug (`?section=<id>`) and stable key. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Line shown above the panel. */
  description?: string;
  /** Rendered under the tab strip when active (lazy: wrap it in Suspense). */
  Component: ComponentType;
};

/** Every section, in tab order. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "tagging",
    label: "AI Tagging",
    icon: Tags,
    description: "How confident the tagger must be, how many tags it keeps, and which model it uses.",
    Component: panel("TaggingSection"),
  },
  {
    id: "prompt-tags",
    label: "Prompt Tags",
    icon: FileText,
    description: "Tags taken from the generation prompt embedded in each image (A1111 / ComfyUI).",
    Component: panel("PromptTagsSection"),
  },
  {
    id: "prompt-guess",
    label: "Prompt Guessing",
    icon: Wand2,
    Component: panel("PromptGuessSection"),
  },
  {
    id: "boilerplate",
    label: "Boilerplate",
    icon: EyeOff,
    Component: panel("BoilerplateSection"),
  },
  {
    id: "tag-colours",
    label: "Tag Colours",
    icon: Palette,
    description: "How tag lists mark hair and eye colours and kinds of tags.",
    Component: panel("TagColoursSection"),
  },
  {
    id: "characters",
    label: "Characters",
    icon: UserRound,
    description: "How character avatars are framed.",
    Component: panel("CharactersSection"),
  },
  {
    id: "sensitivity",
    label: "Sensitivity",
    icon: ShieldCheck,
    Component: panel("SensitivitySection"),
  },
  {
    id: "comfyui",
    label: "ComfyUI",
    icon: Plug,
    Component: panel("ComfySection"),
  },
  {
    id: "about",
    label: "About",
    icon: Info,
    Component: panel("AboutSection"),
  },
];
