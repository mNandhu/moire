import type { LucideIcon } from "lucide-react";
import { Tags, FileText, EyeOff } from "lucide-react";
import { TaggingSection } from "./sections/TaggingSection";
import { PromptTagsSection } from "./sections/PromptTagsSection";
import { BoilerplateSection } from "./sections/BoilerplateSection";

/**
 * One settings page section: a left-nav entry + the panel it renders.
 *
 * To add a new settings section: write a `*Section` component, then append one
 * entry to a group's `items` below. The nav, routing (`?section=<id>`), and
 * active highlight all derive from this registry. No other file needs editing.
 */
export type SettingsSection = {
  /** URL slug (`?section=<id>`) and stable key. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Subtitle shown in the panel header. */
  description?: string;
  /** Rendered in the right-hand content panel when active. */
  Component: () => React.ReactNode;
};

export type SettingsGroup = {
  /** Optional uppercase heading above the group; omit for an ungrouped block. */
  title?: string;
  items: SettingsSection[];
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: "Tags",
    items: [
      {
        id: "tagging",
        label: "AI Tagging",
        icon: Tags,
        description: "How confident the tagger must be, how many tags it keeps, and which model it uses.",
        Component: TaggingSection,
      },
      {
        id: "prompt-tags",
        label: "Prompt Tags",
        icon: FileText,
        description: "Tags taken from the generation prompt embedded in each image (A1111 / ComfyUI).",
        Component: PromptTagsSection,
      },
      {
        id: "boilerplate",
        label: "Boilerplate",
        icon: EyeOff,
        Component: BoilerplateSection,
      },
    ],
  },
];

/** Flattened section list, in nav order. */
export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap(
  (g) => g.items
);
