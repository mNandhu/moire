/** Runs `load` a second after the call, once the page is next idle: work the
 * first screen doesn't need. A second first, since the page sits idle while
 * the gallery's first page is on the wire, so idle alone came too soon.
 * Returns a cancel. */
export function afterBoot(load: () => void): () => void {
  let idle = 0;
  const timer = setTimeout(() => {
    if (typeof requestIdleCallback === "function") idle = requestIdleCallback(load, { timeout: 2000 });
    else load();
  }, 1000);
  return () => {
    clearTimeout(timer);
    if (idle) cancelIdleCallback(idle);
  };
}
