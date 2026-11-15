// Per-tile pipeline latency while scrolling: mount -> img src set -> request start -> response end -> load event,
// and how far ahead of the viewport the tile was when each happened.
// usage: node tile-pipeline.cjs SPEED SECONDS [device]
const { chromium, devices } = require('./paths.cjs').playwright();
const [speed, secs, device] = [+process.argv[2] || 6000, +process.argv[3] || 8, process.argv[4] || 'desktop'];
const BASE = process.env.BASE || 'http://127.0.0.1:8820';
const med = (a) => { a = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); return a.length ? Math.round(a[Math.floor(a.length / 2)] * 10) / 10 : null; };
const p90 = (a) => { a = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); return a.length ? Math.round(a[Math.floor(a.length * 0.9)] * 10) / 10 : null; };
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
  const ctx = await b.newContext(device === 'phone' ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 900 } });
  if (process.env.NOSIB) await ctx.addInitScript({ path: __dirname + '/' + (process.env.NOSIB === 'replace' ? 'nosib-replace.js' : 'nosib.js') });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { performance.setResourceTimingBufferSize(1e6); } catch {} });
  await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await page.waitForTimeout(1500);
  const r = await page.evaluate(([speed, secs]) => new Promise((res) => {
    let e = document.querySelector('[data-tile-index]'); while (e) { const c = getComputedStyle(e); if (/(auto|scroll)/.test(c.overflowY) && e.scrollHeight > e.clientHeight + 10) break; e = e.parentElement; }
    const sc = e; const T = new Map(); // idx -> {mount, src, load, srcUrl, entersAt}
    const vh = sc.clientHeight;
    const mo = new MutationObserver((ms) => { const t = performance.now(); for (const m of ms) {
      if (m.type === 'childList') for (const n of m.addedNodes) { if (!n.querySelectorAll) continue; const tiles = n.matches && n.matches('[data-tile-index]') ? [n] : [...n.querySelectorAll('[data-tile-index]')];
        for (const tl of tiles) { const i = +tl.dataset.tileIndex; if (!T.has(i)) T.set(i, { mount: t, top: tl.getBoundingClientRect().top, st: sc.scrollTop }); } }
      if (m.type === 'attributes' && m.attributeName === 'src' && m.target.tagName === 'IMG' && !m.target.getAttribute('aria-hidden')) { const tl = m.target.closest('[data-tile-index]'); if (!tl) continue; const x = T.get(+tl.dataset.tileIndex); if (x && !x.src && m.target.getAttribute('src')) { x.src = t; x.url = m.target.src; } } } });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    document.addEventListener('load', (ev) => { const im = ev.target; if (im.tagName !== 'IMG') return; const tl = im.closest && im.closest('[data-tile-index]'); if (!tl) return; const x = T.get(+tl.dataset.tileIndex); if (x && !x.load) x.load = performance.now(); }, true);
    const t0 = performance.now(); let last = t0, pos = sc.scrollTop;
    const f = () => { const t = performance.now(); pos += speed * (t - last) / 1000; last = t; sc.scrollTop = pos;
      if (t - t0 > secs * 1000) { mo.disconnect(); const rt = new Map(performance.getEntriesByType('resource').map((x) => [x.name, x]));
        const out = []; for (const [i, x] of T) { if (x.mount < t0 + 300) continue; const q = x.url && rt.get(x.url);
          // when does the tile enter the viewport? its content-top at mount time = x.top + x.st; enters when scrollTop + vh >= that
          const contentTop = x.top + x.st; const enterT = t0 + ((contentTop - vh) - (pos - speed * (t - t0) / 1000)) / speed * 1000;
          out.push({ i, mount: x.mount, src: x.src, req: q ? q.startTime : null, reqStart: q ? q.requestStart : null, resp: q ? q.responseEnd : null, load: x.load, enter: enterT }); }
        return res({ n: out.length, out }); }
      requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }), [speed, secs]);
  const o = r.out;
  const d = (k1, k2) => o.map((x) => (x[k1] != null && x[k2] != null ? x[k2] - x[k1] : null));
  console.log(JSON.stringify({ device, speed, nosib: process.env.NOSIB || false, tiles: r.n,
    mountToSrc: [med(d('mount', 'src')), p90(d('mount', 'src'))], srcToReq: [med(d('src', 'req')), p90(d('src', 'req'))], reqQueue: [med(d('req', 'reqStart')), p90(d('req', 'reqStart'))],
    reqToResp: [med(d('req', 'resp')), p90(d('req', 'resp'))], respToLoad: [med(d('resp', 'load')), p90(d('resp', 'load'))], mountToLoad: [med(d('mount', 'load')), p90(d('mount', 'load'))],
    mountLeadMs: [med(o.map((x) => x.enter - x.mount)), p90(o.map((x) => x.enter - x.mount))], loadedBeforeEnterPct: Math.round(100 * o.filter((x) => x.load && x.load <= x.enter).length / o.length) }));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
