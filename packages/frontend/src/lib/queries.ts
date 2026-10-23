/**
 * Shared server-state queries for data more than one page reads.
 *
 * Overview, Libraries, Tags and the gallery each used to fetch libraries and
 * the tag aggregate in their own `useEffect` into local state, so every visit
 * started from nothing and flashed a loading state. Reading them through one
 * TanStack cache makes moving between pages instant and keeps them in step:
 * a write invalidates the key once and every reader refreshes.
 *
 * Libraries live in lib/libraries.ts; the rest is split by domain under
 * lib/queries/. Both are re-exported here, so importers keep using
 * "lib/queries".
 */

export * from "./libraries";
export * from "./queries/images";
export * from "./queries/tags";
export * from "./queries/settings";
export * from "./queries/board";
