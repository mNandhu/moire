/**
 * How many tabs fit in a row before the rest go under "More". `widths` are
 * the tabs' own widths in order, `gap` the space between neighbours. All fit:
 * no More. Otherwise room is kept for More, which names the active tab when
 * it is one of those moved (so it is `activeMoreWidth` wide then). Pure.
 */
export function visibleTabCount({
  widths,
  available,
  gap,
  moreWidth,
  activeIndex,
  activeMoreWidth,
}: {
  widths: number[];
  available: number;
  gap: number;
  moreWidth: number;
  activeIndex: number;
  activeMoreWidth: number;
}): number {
  const fit = (room: number) => {
    let used = 0;
    let n = 0;
    for (const w of widths) {
      const next = used + (n > 0 ? gap : 0) + w;
      if (next > room) break;
      used = next;
      n++;
    }
    return n;
  };
  if (fit(available) === widths.length) return widths.length;
  const n = fit(available - gap - moreWidth);
  if (activeIndex < n) return n;
  return fit(available - gap - Math.max(moreWidth, activeMoreWidth));
}
