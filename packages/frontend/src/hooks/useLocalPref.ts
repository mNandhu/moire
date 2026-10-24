import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { readLocalPref, subscribeLocalPref, writeLocalPref } from "../lib/localPref";

export type LocalPrefCodec<T> = {
  /** Stored text to a value; throw or return `undefined` for "unusable", which reads as the default. */
  parse?: (raw: string) => T | undefined;
  serialize?: (value: T) => string;
};

/** Booleans are stored "1"/"0", numbers as text, strings as is, the rest as JSON. */
function defaultParse<T>(raw: string, sample: T): T | undefined {
  if (typeof sample === "boolean") return (raw === "1") as T;
  if (typeof sample === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? (n as T) : undefined;
  }
  if (typeof sample === "string") return raw as T;
  return JSON.parse(raw) as T;
}

function defaultSerialize<T>(value: T): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * A view preference kept in localStorage under `key` (lib/localPref.ts lists
 * the keys). Reads and writes never throw, two components on one key stay in
 * step, and so do two tabs. Nothing stored (or an unusable value) reads as
 * `defaultValue`; the default is never written back, only a choice is.
 *
 * `parse` and `serialize` override the codec chosen from the default's type;
 * a parsed object keeps its identity until the stored text changes. The setter
 * also takes an updater, which sees the current value.
 */
export function useLocalPref<T>(
  key: string,
  defaultValue: T,
  { parse, serialize }: LocalPrefCodec<T> = {},
): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback((l: () => void) => subscribeLocalPref(key, l), [key]);
  const raw = useSyncExternalStore(
    subscribe,
    () => readLocalPref(key),
    () => null,
  );
  const defaultRef = useRef(defaultValue);
  defaultRef.current = defaultValue;
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const decode = useCallback((text: string | null): T => {
    if (text === null) return defaultRef.current;
    try {
      const v = parseRef.current ? parseRef.current(text) : defaultParse(text, defaultRef.current);
      return v === undefined ? defaultRef.current : v;
    } catch {
      return defaultRef.current;
    }
  }, []);

  // Memoised on the stored text, so an object value is stable between renders.
  // A changed default (a media-query fallback) only shows while nothing is stored.
  const stored = useMemo(() => (raw === null ? undefined : { value: decode(raw) }), [raw, decode]);
  const value = stored ? stored.value : defaultValue;

  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const raw = readLocalPref(key);
      const prev = decode(raw);
      const updater = typeof next === "function";
      const v = updater ? (next as (p: T) => T)(prev) : next;
      // An updater that changed nothing writes nothing (nor stores the default),
      // and neither does a value already stored as is. A plain value equal to
      // the default is still a choice, kept over a default that changes later.
      if (updater && Object.is(v, prev)) return;
      const text = (serializeRef.current ?? defaultSerialize)(v);
      if (text !== raw) writeLocalPref(key, text);
    },
    [key, decode],
  );
  return [value, set];
}

/** For a Set of strings, stored as a JSON array. */
export const KEY_SET: LocalPrefCodec<Set<string>> = {
  parse: (raw) => new Set(JSON.parse(raw) as string[]),
  serialize: (s) => JSON.stringify([...s]),
};
