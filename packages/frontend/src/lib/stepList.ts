import { createContext } from "react";
import type { Location } from "react-router-dom";
import type { FeedItem } from "./imageFilter";

/** What ImageView needs of an image it can step to. */
export type StepItem = Pick<FeedItem, "_id" | "width" | "height"> & { thumb_url: string | null };

/**
 * The images a page is showing, for ImageView to step through instead of the
 * Image feed when one of them is opened (Generate's output column, a batch).
 * Null: the page has no list of its own, so the viewer walks the feed.
 */
export const StepListContext = createContext<StepItem[] | null>(null);

type StateWithSteps = { steps?: StepItem[] } | null | undefined;

/** The list ImageView was opened with, carried in the history `state`
 * (it survives stepping and a reload); undefined for the Image feed. */
export function getSteps(location: Pick<Location, "state">): StepItem[] | undefined {
  const steps = (location.state as StateWithSteps)?.steps;
  return Array.isArray(steps) ? steps : undefined;
}
