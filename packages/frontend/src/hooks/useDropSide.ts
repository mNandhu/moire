import { useLayoutEffect, useState, type RefObject } from "react";
import { dropSide } from "../lib/dropSide";

/**
 * dropSide for a dropdown under `field`, kept current while it is open: as
 * the page scrolls and as a phone's keyboard opens (it shrinks the visual
 * viewport after the field takes focus).
 */
export function useDropSide(field: RefObject<HTMLElement>, open: boolean, want: number) {
  const [side, setSide] = useState({ up: false, max: want });
  useLayoutEffect(() => {
    const el = field.current;
    if (!open || !el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const vv = window.visualViewport;
      const top = vv?.offsetTop ?? 0;
      const bottom = top + (vv?.height ?? window.innerHeight);
      const next = dropSide(r.top - top, bottom - r.bottom, want);
      setSide((s) => (s.up === next.up && s.max === next.max ? s : next));
    };
    measure();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [field, open, want]);
  return side;
}
