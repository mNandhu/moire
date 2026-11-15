// Delete Tailwind's `X > :not([hidden]) ~ :not([hidden])` rules (space-y-*, divide-*), recursing into @media/@layer groups.
(() => {
  const strip = () => {
    let n = 0;
    const walk = (g) => { const rules = g.cssRules; for (let i = rules.length - 1; i >= 0; i--) { const r = rules[i];
      if (!r.selectorText && r.cssRules) { walk(r); continue; }
      if (/:not\(\[hidden\]\)\s*~\s*:not\(\[hidden\]\)/.test(r.selectorText || '')) { g.deleteRule(i); n++; } } };
    for (const ss of document.styleSheets) { try { walk(ss); } catch {} }
    window.__nosib = (window.__nosib || 0) + n;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', strip); else strip();
  addEventListener('load', strip);
})();
