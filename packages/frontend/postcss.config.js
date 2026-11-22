import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// Tailwind v3 writes space-* and divide-* as `X > :not([hidden]) ~ :not([hidden])`.
// A general-sibling combinator makes Chrome restyle every later sibling when one
// child mounts, and the virtualized gallery mounts a tile subtree per scroll
// frame (~1,100 elements restyled each). `:not(:first-child)` selects the same
// elements with no sibling dependency, at the same specificity.
// One edge differs: a first child carrying the `hidden` attribute used to leave
// the second child unspaced; now the second is spaced. Don't set `hidden` on
// the first child of a space-* or divide-* container.
const SIBLING = ":not([hidden]) ~ :not([hidden])";
const noSiblingCombinator = {
  postcssPlugin: "no-sibling-combinator",
  Rule(rule) {
    if (rule.selector.includes(SIBLING)) {
      rule.selector = rule.selector.replaceAll(SIBLING, ":not([hidden]):not(:first-child)");
    }
  },
};

export default {
  plugins: [
    tailwindcss(),
    // After tailwindcss, which generates the rules this rewrites.
    noSiblingCombinator,
    autoprefixer(),
  ],
};
