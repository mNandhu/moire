// Candidate fix: rewrite `X > :not([hidden]) ~ :not([hidden])` to `X > :not([hidden]):not(:first-child)` (same declarations).
(() => {
  const swap = () => {
    let n = 0;
    const walk = (g) => { const rules = g.cssRules; for (let i = rules.length - 1; i >= 0; i--) { const r = rules[i];
      if (!r.selectorText && r.cssRules) { walk(r); continue; }
      const t = r.selectorText || '';
      if (/:not\(\[hidden\]\)\s*~\s*:not\(\[hidden\]\)/.test(t)) { const body = r.style.cssText; const sel = t.replace(/:not\(\[hidden\]\)\s*~\s*:not\(\[hidden\]\)/g, ':not([hidden]):not(:first-child)');
        g.deleteRule(i); g.insertRule(`${sel}{${body}}`, i); n++; } } };
    for (const ss of document.styleSheets) { try { walk(ss); } catch {} }
    window.__nosib = (window.__nosib || 0) + n;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', swap); else swap();
  addEventListener('load', swap);
})();
