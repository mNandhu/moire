import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../../lib/cn";

export type PromptMark = { start: number; end: number; reason: string };

/** Words the app just wrote into the prompt: lit up and fading (a new `key`
 * replays it), with an optional note at the first of them for a while. */
export type PromptFlash = { key: number; ranges: readonly { start: number; end: number }[]; note?: ReactNode };

// How long a flash's note stays up.
const NOTE_MS = 5000;

/** What decides where a line wraps: copied from the textarea to the copy
 * behind it. */
const MIRRORED = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-feature-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
] as const;

/**
 * The marks overlay: a copy of the prompt text drawn behind the (transparent)
 * textarea, so marked terms and freshly written words wrap and scroll with
 * it, plus the bubble (a mark's reason and fix) and the flash's note. Returns
 * the pieces to place (`backdrop` before the textarea, `popovers` after it)
 * and the textarea handlers that drive them. `suggestOpen` keeps the bubble
 * and note out of the suggestion list's way.
 */
export function usePromptMarks({
  textareaRef,
  wrapRef,
  value,
  marks,
  fix,
  flash,
  className,
  suggestOpen,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  wrapRef: RefObject<HTMLDivElement | null>;
  value: string;
  marks: readonly PromptMark[];
  fix?: { label: string; apply: () => void } | null;
  flash?: PromptFlash | null;
  className?: string;
  suggestOpen: boolean;
}) {
  const ref = textareaRef;
  // Marked terms: drawn on a copy of the text behind the (transparent)
  // textarea, so they wrap and scroll with it.
  const backRef = useRef<HTMLDivElement>(null);
  const markRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [bubbleAt, setBubbleAt] = useState<{ left: number; top: number } | null>(null);
  const markAt = (i: number | null) => {
    const span = i == null ? null : markRefs.current[i];
    const el = ref.current;
    if (i == null || !span || !el) {
      setShown(null);
      return;
    }
    setShown(i);
    const room = (wrapRef.current?.clientWidth ?? el.clientWidth) - 288;
    setBubbleAt({
      left: Math.max(0, Math.min(span.offsetLeft, room)),
      top: el.offsetTop + span.offsetTop - el.scrollTop + span.offsetHeight + 4,
    });
  };
  const markUnder = (x: number, y: number) =>
    markRefs.current.findIndex((m) =>
      m ? [...m.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) : false,
    );
  const markAtCaret = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return -1;
    const c = el.selectionStart;
    return marks.findIndex((m) => c >= m.start && c <= m.end);
  };
  // Any change to the marks closes the bubble: its index and place are stale.
  const marksKey = marks.map((m) => `${m.start}:${m.end}:${m.reason}`).join("|");
  useEffect(() => {
    markRefs.current = markRefs.current.slice(0, marks.length);
    setShown(null);
  }, [marksKey, marks.length]);
  // The copy behind must wrap exactly like the textarea, or an outline lands
  // on the wrong words: it takes the textarea's own box and text styles, and
  // its width less any scrollbar, and follows its scroll.
  // Styles and size: on mount, restyle and resize. Scroll: as it scrolls
  // and as text is typed.
  const syncScroll = useCallback(() => {
    if (ref.current && backRef.current) backRef.current.scrollTop = ref.current.scrollTop;
  }, [ref]);
  const syncBack = useCallback(() => {
    const el = ref.current;
    const back = backRef.current;
    if (!el || !back) return;
    const cs = getComputedStyle(el);
    for (const p of MIRRORED) back.style.setProperty(p, cs.getPropertyValue(p));
    const bx = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const by = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    back.style.borderColor = "transparent";
    back.style.boxSizing = "border-box";
    back.style.width = `${el.clientWidth + bx}px`;
    back.style.height = `${el.clientHeight + by}px`;
    back.style.top = `${el.offsetTop}px`;
    back.style.left = `${el.offsetLeft}px`;
    back.scrollTop = el.scrollTop;
  }, [ref]);
  // A flash shows until its glow is over (its note a while longer), then the
  // copy behind goes back to marks only.
  // With the text it was made for: once the prompt is edited its offsets
  // (and an undo that puts the old prompt back) no longer hold, so it goes.
  const [flashing, setFlashing] = useState<(PromptFlash & { text: string }) | null>(null);
  const [noteAt, setNoteAt] = useState<{ left: number; top: number } | null>(null);
  const flashRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!flash?.ranges.length) {
      setFlashing(null);
      return;
    }
    // The page sets the prompt and the flash together, so `value` is the
    // text the flash was made for.
    setFlashing({ ...flash, text: value });
    const t = setTimeout(() => setFlashing(null), flash.note ? NOTE_MS : 2400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  const current = flashing?.text === value ? flashing : null;
  const lit = current?.ranges ?? [];
  const hasMarks = marks.length > 0 || lit.length > 0;
  useLayoutEffect(syncBack, [syncBack, hasMarks, className]);
  useLayoutEffect(syncScroll, [syncScroll, value, marksKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMarks) return;
    // Content box: a scrollbar coming or going resizes it too.
    const ro = new ResizeObserver(syncBack);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncBack, hasMarks, ref]);

  useLayoutEffect(() => {
    const span = flashRef.current;
    const el = ref.current;
    if (!flashing?.note || !span || !el) {
      setNoteAt(null);
      return;
    }
    // The note is at most 20rem wide (max-w-xs).
    const room = (wrapRef.current?.clientWidth ?? el.clientWidth) - 320;
    setNoteAt({
      left: Math.max(0, Math.min(span.offsetLeft, room)),
      top: el.offsetTop + span.offsetTop - el.scrollTop + span.offsetHeight + 4,
    });
  }, [flashing, ref, wrapRef]);
  // Marks and lit words in text order, for the copy behind.
  const segments = [
    ...marks.map((m, i) => ({ start: m.start, end: m.end, mark: i })),
    ...lit.map((r) => ({ start: r.start, end: r.end, mark: -1 })),
  ]
    .sort((a, b) => a.start - b.start)
    .filter((sg, i, all) => i === 0 || sg.start >= all[i - 1].end);
  const firstLit = segments.findIndex((sg) => sg.mark < 0);

  const mark = shown != null && !suggestOpen ? marks[shown] : null;

  const backdrop =
    segments.length > 0 ? (
      <div
        ref={backRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-transparent",
          className,
        )}
      >
        {segments.map((m, i) => (
          <span key={`${m.start}:${m.end}`}>
            {value.slice(i ? segments[i - 1].end : 0, m.start)}
            {m.mark >= 0 ? (
              <span
                ref={(el) => {
                  markRefs.current[m.mark] = el;
                }}
                className="rounded-sm bg-amber-400/10 shadow-[0_0_0_1px_rgb(251_191_36/0.8)]"
              >
                {value.slice(m.start, m.end)}
              </span>
            ) : (
              <span
                key={flashing?.key}
                ref={i === firstLit ? flashRef : undefined}
                className="rounded-sm animate-written-glow"
              >
                {value.slice(m.start, m.end)}
              </span>
            )}
          </span>
        ))}
        {value.slice(segments[segments.length - 1].end)}
        {/* A trailing newline only takes up a line with something after it. */}
        {"​"}
      </div>
    ) : null;

  const popovers = (
    <>
      {current?.note && noteAt && !mark && (
        <div
          role="status"
          className="absolute z-30 flex w-max max-w-xs animate-fade-in items-center gap-2 rounded-lg border border-brand-700/60 bg-raised px-2.5 py-2 text-xs text-neutral-200 shadow-panel"
          style={{ left: noteAt.left, top: noteAt.top }}
        >
          {current.note}
        </div>
      )}
      {mark && bubbleAt && (
        <div
          role="note"
          className="absolute z-30 w-72 rounded-lg border border-amber-700/60 bg-raised p-2.5 text-xs text-neutral-200 shadow-panel"
          style={{ left: bubbleAt.left, top: bubbleAt.top }}
        >
          <p>{mark.reason}</p>
          {fix && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                fix.apply();
                setShown(null);
              }}
              className="mt-2 rounded-md border border-amber-700/70 bg-amber-900/30 px-2 py-1 text-amber-100 hover:bg-amber-900/50"
            >
              {fix.label}
            </button>
          )}
        </div>
      )}
    </>
  );

  return {
    backdrop,
    popovers,
    /** Close the bubble (the pointer left the field). */
    hide: () => setShown(null),
    /** Escape closes an open bubble while no list is up; true if it did. */
    onEscape: (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && shown != null && !suggestOpen) {
        e.stopPropagation();
        setShown(null);
        return true;
      }
      return false;
    },
    onKeyUp: (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") markAt(markAtCaret());
    },
    onClick: () => markAt(markAtCaret()),
    onScroll: () => {
      syncScroll();
      setShown(null);
    },
    onMouseMove: (e: MouseEvent<HTMLTextAreaElement>) => {
      if (!marks.length) return;
      const i = markUnder(e.clientX, e.clientY);
      if (i >= 0 && i !== shown) markAt(i);
    },
  };
}
