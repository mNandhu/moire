// Timestamp each hop of an ArrowRight step in the image view (20 steps):
// keydown -> URL change -> main <img alt="image"> src set -> its load event -> class gains opacity-100 (pending cleared).
const { chromium } = require('./paths.cjs').playwright();
const BASE = process.env.BASE || 'http://127.0.0.1:8820';
const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? +a[Math.floor((a.length - 1) / 2)].toFixed(1) : null; };
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(BASE + '/'); await p.waitForSelector('[data-tile-index] img'); await p.waitForTimeout(1200);
  await p.locator('[data-tile-index="0"] img').click(); await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const H = (window.__H = []); let cur = null;
    document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { cur = { key: e.timeStamp, path: location.pathname }; H.push(cur); } }, true);
    const chk = () => { if (cur && !cur.url && location.pathname !== cur.path) cur.url = performance.now(); requestAnimationFrame(chk); }; chk();
    // pushState hook for exact URL time
    const ps = history.pushState.bind(history), rs = history.replaceState.bind(history);
    history.pushState = (...a) => { const r = ps(...a); if (cur && !cur.url) cur.url = performance.now(); return r; };
    history.replaceState = (...a) => { const r = rs(...a); if (cur && !cur.url && location.pathname !== cur.path) cur.url = performance.now(); return r; };
    new MutationObserver((ms) => { const t = performance.now(); for (const m of ms) { const el = m.target; if (el.tagName !== 'IMG' || el.getAttribute('alt') !== 'image' || !cur) continue;
      if (m.attributeName === 'src' && !cur.src && cur.url) cur.src = t;
      if (m.attributeName === 'class' && cur.src && !cur.shown && /\bopacity-100\b/.test(el.className)) cur.shown = t;
      if (m.attributeName === 'class' && cur.url && !cur.pending && /\bopacity-40\b/.test(el.className)) cur.pending = t; } })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
    document.addEventListener('load', (e) => { const el = e.target; if (cur && el.tagName === 'IMG' && el.getAttribute('alt') === 'image' && cur.src && !cur.load) cur.load = performance.now(); }, true);
  });
  for (let i = 0; i < 20; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(400); }
  const H = await p.evaluate(() => __H);
  const d = (k) => H.map((h) => (h[k] ? h[k] - h.key : null));
  const out = { steps: H.length, keyToUrl: med(d('url')), keyToPendingDim: med(d('pending')), keyToSrcSet: med(d('src')), keyToLoad: med(d('load')), keyToShown: med(d('shown')),
    urlToSrc: med(H.map((h) => (h.src && h.url ? h.src - h.url : null))), srcToLoad: med(H.map((h) => (h.load && h.src ? h.load - h.src : null))), loadToShown: med(H.map((h) => (h.shown && h.load ? h.shown - h.load : null))) };
  console.log(JSON.stringify(out));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
