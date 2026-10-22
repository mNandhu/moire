import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Box, FolderOpen, History, Layers, Plus, Puzzle, Search, Settings, Tags, Wand2 } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { CharacterAvatar } from "./CharacterAvatar";
import { useCharacters } from "./ImageCharacters";
import { NAV } from "./Sidebar";
import { SETTINGS_SECTIONS } from "../pages/settings/registry";
import { cn } from "../lib/cn";
import { smallThumb } from "../lib/media";
import {
  imageEmbeddingsQuery,
  imageLorasQuery,
  imageModelsQuery,
  useLibraries,
  useTagBrowse,
  useTagGroups,
} from "../lib/queries";
import { useBatches, useGenerators } from "../lib/generate";
import {
  GROUP_LABEL,
  characterItems,
  generationItems,
  libraryItems,
  resourceItems,
  searchSections,
  tagItems,
  groupItems,
  workflowItems,
  type SearchGroup,
  type SearchItem,
} from "../lib/search";

/** Pages: the sidebar's, then Settings and its sections, then "New workflow". */
const PAGES: { item: SearchItem; icon: LucideIcon }[] = [
  ...NAV.flatMap((g): readonly { label: string; path: string; icon: LucideIcon }[] => g.items).map(({ label, path, icon }) => ({
    item: { key: `page:${path}`, group: "pages" as const, label, href: path },
    icon,
  })),
  { item: { key: "page:/settings", group: "pages", label: "Settings", href: "/settings" }, icon: Settings },
  {
    item: { key: "page:/generate/workflows/new", group: "pages", label: "New workflow", detail: "Generate", href: "/generate/workflows/new" },
    icon: Plus,
  },
  ...SETTINGS_SECTIONS.map((s) => ({
    item: {
      key: `settings:${s.id}`,
      group: "settings" as const,
      label: s.label,
      href: `/settings?${new URLSearchParams({ section: s.id })}`,
    },
    icon: s.icon,
  })),
];
const PAGE_ICON = new Map(PAGES.map((p) => [p.item.key, p.icon]));

const GROUP_ICON: Partial<Record<SearchGroup, LucideIcon>> = {
  tags: Tags,
  workflows: Wand2,
  generations: History,
  libraries: FolderOpen,
  loras: Layers,
  embeddings: Puzzle,
  checkpoints: Box,
};

const NONE: never[] = [];

/**
 * Ctrl/Cmd+K: one search over the app's pages, settings, characters, tags,
 * workflows, generations, libraries and the models images used. Arrow keys
 * move, Enter opens, Escape closes. The lists load when it opens.
 */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} placement="top" ariaLabel="Search" className="max-w-xl p-0 overflow-hidden">
      <SearchBody onClose={onClose} />
    </Dialog>
  );
}

function SearchBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  // The highlighted row by key, so a list that loads or refreshes under it
  // (a running batch polls) doesn't move the highlight to another row.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const characters = useCharacters();
  // Lists that rarely change between opens: refetched at most once a minute.
  const tags = useTagBrowse("all", { staleTime: 60_000 });
  const groups = useTagGroups();
  const workflows = useGenerators();
  const batches = useBatches();
  const libraries = useLibraries({ poll: false });
  const loras = useQuery({ ...imageLorasQuery, staleTime: 60_000 });
  const embeddings = useQuery({ ...imageEmbeddingsQuery, staleTime: 60_000 });
  const models = useQuery({ ...imageModelsQuery, staleTime: 60_000 });
  const loading = [characters, tags, workflows, batches, libraries, loras, embeddings, models].some((q) => q.isLoading);

  const items = useMemo(
    () => [
      ...PAGES.map((p) => p.item),
      ...characterItems(characters.data ?? NONE),
      ...tagItems(tags.data ?? NONE),
      ...groupItems(groups.data),
      ...workflowItems(workflows.data ?? NONE),
      ...generationItems(batches.data ?? NONE),
      ...libraryItems(libraries.data ?? NONE),
      ...resourceItems("loras", loras.data ?? NONE),
      ...resourceItems("embeddings", embeddings.data ?? NONE),
      ...resourceItems("checkpoints", (models.data ?? NONE).map((m) => ({ name: m.model, count: m.count }))),
    ],
    [characters.data, tags.data, groups.data, workflows.data, batches.data, libraries.data, loras.data, embeddings.data, models.data],
  );
  const sections = useMemo(() => searchSections(query, items), [query, items]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const active = Math.max(0, flat.findIndex((x) => x.key === activeKey));
  const setActive = (i: number) => setActiveKey(flat[i]?.key ?? null);

  useEffect(() => setActiveKey(null), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (item: SearchItem | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + flat.length) % flat.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      go(flat[active]);
    }
  };

  let index = -1;
  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex h-12 items-center gap-3 border-b border-line px-4">
        <Search size={18} className="shrink-0 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search characters, tags, workflows, pages…"
          aria-label="Search"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-neutral-100 outline-none focus-visible:shadow-none placeholder:text-faint"
        />
      </div>
      {flat.length === 0 && (
        <p role="status" className="px-4 py-6 text-center text-sm text-faint">
          {loading ? "Loading…" : `Nothing matches “${query.trim()}”`}
        </p>
      )}
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Results"
        className={cn("max-h-[min(60vh,28rem)] overflow-y-auto py-1.5", flat.length === 0 && "hidden")}
      >
        {sections.map((s) => (
          <React.Fragment key={s.group}>
            <li role="presentation" className="px-4 pb-1 pt-2.5 text-2xs uppercase tracking-wider text-faint">
              {GROUP_LABEL[s.group]}
            </li>
            {s.items.map((item) => {
              const i = ++index;
              return (
                <li key={item.key} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={i === active}>
                  {/* A real link: Ctrl/middle-click opens it in a new tab. */}
                  <Link
                    to={item.href}
                    tabIndex={-1}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={(e) => {
                      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) onClose();
                    }}
                    className={cn(
                      "mx-1.5 flex items-center gap-3 rounded-md px-2.5 py-1.5 text-sm",
                      i === active && "bg-brand-900/40",
                    )}
                  >
                    <Visual item={item} />
                    <span className="min-w-0 flex-1 truncate text-neutral-100">
                      {item.label}
                      {item.detail && <span className="ml-2 text-xs text-faint">{item.detail}</span>}
                    </span>
                    {item.hint && <span className="shrink-0 text-xs tabular-nums text-faint">{item.hint}</span>}
                  </Link>
                </li>
              );
            })}
          </React.Fragment>
        ))}
      </ul>
    </div>
  );
}

/** What leads a row: a character's face, a tag's or batch's cover, else
 * the icon its page or kind has in the sidebar. */
function Visual({ item }: { item: SearchItem }) {
  const box = "h-7 w-7 shrink-0";
  if (item.character) {
    const c = item.character;
    return (
      <CharacterAvatar src={c.thumb_url} face={c.face} focus={c.focus} aspect={c.aspect} letter={item.label} className={box} />
    );
  }
  if (item.thumb) return <img src={smallThumb(item.thumb)} alt="" loading="lazy" className={cn(box, "rounded-md object-cover bg-raised")} />;
  const Icon = PAGE_ICON.get(item.key) ?? GROUP_ICON[item.group];
  return (
    <span className={cn(box, "grid place-items-center rounded-md text-muted")}>
      {Icon && <Icon size={16} />}
    </span>
  );
}
