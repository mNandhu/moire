/**
 * The ambient wash behind the app takes its colours from the images in view
 * (see `ambientPalette` in ./blurhash). The gallery sets them; every other
 * page keeps the last palette, which is persisted so a fresh load of any page
 * looks the same as the gallery left it rather than snapping to the fallback.
 */

const KEY = "ambient:palette";
const VARS = ["--amb1", "--amb2", "--amb3"] as const;
// Only what ambientPalette produces is accepted back from storage.
const HSL = /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/;

/** Normalize to exactly three valid colours, or null if none are usable. */
export function normalizePalette(colors: unknown): string[] | null {
  if (!Array.isArray(colors)) return null;
  const ok = colors.filter((c): c is string => typeof c === "string" && HSL.test(c));
  if (!ok.length) return null;
  return VARS.map((_, i) => ok[i] ?? ok[0]);
}

function setVars(palette: string[]) {
  const style = document.documentElement.style;
  VARS.forEach((v, i) => style.setProperty(v, palette[i]));
}

export function applyAmbient(colors: string[]) {
  const palette = normalizePalette(colors);
  if (!palette) return;
  setVars(palette);
  try {
    localStorage.setItem(KEY, JSON.stringify(palette));
  } catch {
    /* storage unavailable: the wash still applies for this session */
  }
}

export function restoreAmbient() {
  try {
    const raw = localStorage.getItem(KEY);
    const palette = raw ? normalizePalette(JSON.parse(raw)) : null;
    if (palette) setVars(palette);
  } catch {
    /* corrupt or unavailable storage: keep the CSS fallback */
  }
}

/**
 * Light the wash with one page's own colours (a character page) while it is
 * open: returns the undo, which puts the previous palette back. Nothing is
 * stored, so leaving the page leaves the gallery's palette as it was.
 */
export function tintAmbient(colors: readonly string[]): () => void {
  // Nothing to light with (still loading): touch nothing, so the undo can't
  // put back a palette read before the app restored the stored one.
  if (!colors.length) return () => {};
  const style = document.documentElement.style;
  const prev = VARS.map((v) => style.getPropertyValue(v));
  VARS.forEach((v, i) => style.setProperty(v, colors[i] ?? colors[0]));
  return () =>
    VARS.forEach((v, i) => (prev[i] ? style.setProperty(v, prev[i]) : style.removeProperty(v)));
}
