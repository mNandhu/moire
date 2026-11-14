/** The list's scrollTop that brings a row fully into view, moving as little
 * as it can (null: already in view). Only the list scrolls, never the page
 * around it, which `scrollIntoView` would also move. Pure. */
export function scrollTopFor(
  list: { scrollTop: number; clientHeight: number },
  row: { offsetTop: number; offsetHeight: number },
): number | null {
  if (row.offsetTop < list.scrollTop) return row.offsetTop;
  const bottom = row.offsetTop + row.offsetHeight;
  if (bottom > list.scrollTop + list.clientHeight) return bottom - list.clientHeight;
  return null;
}
