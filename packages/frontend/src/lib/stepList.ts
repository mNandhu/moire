import { createContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { Location } from "react-router-dom";
import type { FeedItem } from "@/features/images/lib/imageFilter";

/** What ImageView needs of an image it can step to. */
export type StepItem = Pick<FeedItem, "_id" | "width" | "height"> & { thumb_url: string | null };

/** A page's step list: its name in the store below and the images now. */
export type StepList = { name: string; items: StepItem[] };

/**
 * The images a page is showing, for ImageView to step through instead of the
 * Image feed when one of them is opened (Generate's output column, a batch).
 * Null: the page has no list of its own, so the viewer walks the feed.
 */
export const StepListContext = createContext<StepList | null>(null);

// Live lists by name. The page under the viewer keeps publishing its own, so
// an image made after the viewer opened is a step away too.
const lists = new Map<string, StepItem[]>();
const subs = new Set<() => void>();

/** Same images, in the same order, with the same thumbnails. */
export function sameSteps(a: readonly StepItem[], b: readonly StepItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x._id === b[i]._id && x.thumb_url === b[i].thumb_url);
}

/** Puts up (or, with null, takes down) the list called `name`. */
export function publishSteps(name: string, items: StepItem[] | null): void {
  const now = lists.get(name);
  if (items ? now && sameSteps(now, items) : !now) return;
  if (items) lists.set(name, items);
  else lists.delete(name);
  for (const f of subs) f();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

type StateWithSteps = { steps?: StepList } | null | undefined;

/** The history `state` an image opened from `list` carries: the list's name
 * and the images at the click, used while the page has not published (a
 * reload). */
export const stepsState = (list: StepList) => ({ steps: list });

/** The list ImageView was opened with, live while its page publishes it;
 * undefined for the Image feed. */
export function useSteps(location: Pick<Location, "state">): StepItem[] | undefined {
  const opened = (location.state as StateWithSteps)?.steps;
  const name = opened && typeof opened.name === "string" ? opened.name : undefined;
  const live = useSyncExternalStore(subscribe, () => (name ? lists.get(name) : undefined));
  return live ?? (opened && Array.isArray(opened.items) ? opened.items : undefined);
}

/** A page's list for `StepListContext`, published as `name` while the page
 * is up. The same value until the images change, so a poll that brings
 * nothing new re-renders no tile. */
export function useStepList(name: string, items: StepItem[]): StepList {
  const ref = useRef<StepList | null>(null);
  if (!ref.current || ref.current.name !== name || !sameSteps(ref.current.items, items)) ref.current = { name, items };
  const list = ref.current;
  useEffect(() => publishSteps(list.name, list.items), [list]);
  useEffect(() => () => publishSteps(name, null), [name]);
  return list;
}
