// Moiré frontend browser benchmark (measure only).
// usage: node web-bench.cjs SCENARIO RUNS [key=val ...]
//   SCENARIO: boot | scroll | viewer | pages | typing | coverage
//   BASE=http://127.0.0.1:8820 (env), device=desktop|phone, speed=px/s, target=tiles,
//   react=1 (install a DevTools-hook commit recorder; needs the react-dom/profiling build)
// Output: one JSON line per run on stdout, prefixed with "RUN ", and a "SUMMARY " line.
const { chromium, devices } = require('./paths.cjs').playwright();
const fs = require('fs');
const [scenario, runsArg, ...kv] = process.argv.slice(2);
const RUNS = +runsArg || 5;
const opt = Object.fromEntries(kv.map((s) => s.split('=')));
const BASE = process.env.BASE || 'http://127.0.0.1:8820';
const OUT = require('./paths.cjs').OUT;

const INIT = () => {
  try { performance.setResourceTimingBufferSize(1e6); } catch {}
  const P = (window.__P = { lt: [], loaf: [], paint: {}, lcp: [], ev: [], keys: [], commits: [] });
  const obs = (type, fn, extra = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {} };
  obs('longtask', (e) => P.lt.push([e.startTime, e.duration]));
  obs('long-animation-frame', (e) => P.loaf.push({ s: e.startTime, d: e.duration, b: e.blockingDuration, r: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
    sl: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
    sc: (e.scripts || []).map((s) => ({ u: (s.sourceURL || '').replace(/.*\//, ''), f: s.sourceFunctionName, i: s.invoker, t: s.invokerType, d: s.duration, l: s.forcedStyleAndLayoutDuration, c: s.sourceCharPosition })) }));
  obs('paint', (e) => (P.paint[e.name] = e.startTime));
  obs('largest-contentful-paint', (e) => P.lcp.push([e.startTime, e.size, e.element ? e.element.tagName : '']));
  obs('event', (e) => P.ev.push({ n: e.name, s: e.startTime, d: e.duration, id: e.interactionId, ps: e.processingStart - e.startTime, pd: e.processingEnd - e.processingStart }), { durationThreshold: 16 });
  // keydown -> next frame (rAF + task), for keystrokes below the event-timing threshold
  addEventListener('keydown', (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => setTimeout(() => P.keys.push({ k: e.key, ms: performance.now() - t0 }), 0)); }, true);
  // gallery tile sampler
  window.__vis = () => { const o = []; document.querySelectorAll('[data-tile-index] img').forEach((i) => { const r = i.getBoundingClientRect(); if (r.bottom > 0 && r.top < innerHeight && r.width > 0 && !i.getAttribute('aria-hidden')) o.push(i); }); return o; };
  window.__loaded = (i) => !!(i.getAttribute('src') && i.complete && i.naturalWidth > 0);
  window.__scroller = () => { let e = document.querySelector('[data-tile-index]'); while (e) { const c = getComputedStyle(e); if (/(auto|scroll)/.test(c.overflowY) && e.scrollHeight > e.clientHeight + 10) return e; e = e.parentElement; } return document.scrollingElement; };
  // boot milestones, sampled each frame from the start
  const B = (P.boot = { firstTile: 0, first12: 0, allVis: 0, nVis: 0 });
  const tick = () => {
    const v = window.__vis ? __vis() : [];
    const t = performance.now();
    if (v.length && !B.firstTile) B.firstTile = t;
    const done = v.filter(__loaded).length;
    if (!B.first12 && done >= Math.min(12, v.length) && v.length) B.first12 = t;
    if (v.length && done === v.length) { B.allVis = t; B.nVis = v.length; return; }
    if (t < 30000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (window.__REACT_REC) {
    const names = new Map();
    const nm = (f) => { const t = f.type; if (!t) return null; if (typeof t === 'string') return null; return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null; };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map(), supportsFiber: true, isDisabled: false, inject(r) { this.renderers.set(1, r); return 1; }, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot(id, root) {
        if (!window.__REC_ON) return;
        const t0 = performance.now(); const agg = {}; let total = 0; const stack = [root.current];
        while (stack.length) { const f = stack.pop(); if ((f.flags & 1) && f.selfBaseDuration != null) { const n = nm(f); if (n) { const a = (agg[n] = agg[n] || [0, 0]); a[0]++; a[1] += f.selfBaseDuration; total += f.selfBaseDuration; } }
          if (f.sibling) stack.push(f.sibling); if (f.child && !(f.alternate && f.child === f.alternate.child)) stack.push(f.child); }
        P.commits.push({ t: t0, total, dur: root.current.actualDuration, agg, walk: performance.now() - t0 });
      } };
  }
};

const med = (a) => { a = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const pct = (a, p) => { a = [...a].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };
const r1 = (x) => (x == null ? x : Math.round(x * 10) / 10);

async function newPage(browser, device) {
  const ctxOpt = device === 'phone' ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext(ctxOpt);
  if (opt.react) await ctx.addInitScript('window.__REACT_REC=1; window.__REC_ON=1');
  if (opt.nosib) await ctx.addInitScript({ path: __dirname + '/' + (opt.nosib === 'replace' ? 'nosib-replace.js' : 'nosib.js') });
  if (opt.fade) await ctx.addInitScript({ path: __dirname + '/fade-' + opt.fade + '.js' });
  if (opt.cpu) { /* set after page creation */ }
  if (opt.nofade) await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation:none!important}'; document.head.appendChild(s); }));
  await ctx.addInitScript(INIT);
  if (opt.thumb) await ctx.route(/\/thumb\?v=[^&]*$/, (r) => r.continue(opt.thumb === 'small' ? { url: r.request().url() + '&size=small' } : {}));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (opt.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: +opt.cpu });
  if (opt.net === 'wan') { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 50e6 / 8, uploadThroughput: 20e6 / 8 }); }
  return { ctx, page, cdp };
}
async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  return { heapMB: r1(m.JSHeapUsedSize / 1e6), nodes: m.Nodes, listeners: m.JSEventListeners, layouts: m.LayoutCount, styles: m.RecalcStyleCount, scriptS: r1(m.ScriptDuration), taskS: r1(m.TaskDuration) };
}
const res = (page) => page.evaluate(() => performance.getEntriesByType('resource').map((e) => ({ u: e.name.replace(location.origin, ''), s: e.startTime, q: e.requestStart ? e.requestStart - e.startTime : 0, rs: e.responseStart, e: e.responseEnd, tx: e.transferSize, enc: e.encodedBodySize, dec: e.decodedBodySize, p: e.nextHopProtocol, it: e.initiatorType })));
const isApi = (u) => u.startsWith('/api/') && !/\/thumb(\?|$)/.test(u) && !/\/file(\?|$)/.test(u);
const isThumb = (u) => /\/thumb(\?|$)/.test(u);
function ltStats(lt, from = 0, to = 1e12) { const x = lt.filter(([s]) => s >= from && s < to); return { n: x.length, sum: r1(x.reduce((a, [, d]) => a + d, 0)), max: r1(Math.max(0, ...x.map(([, d]) => d))) }; }
// aggregate LoAF script attribution
function loafTop(loaf, from = 0, to = 1e12, k = 8) {
  const agg = {};
  for (const f of loaf) if (f.s >= from && f.s < to) for (const s of f.sc) { const key = `${s.t}:${s.i}|${s.f || '?'}@${s.u}:${s.c}`; const a = (agg[key] = agg[key] || [0, 0, 0]); a[0]++; a[1] += s.d; a[2] += s.l || 0; }
  return Object.entries(agg).sort((a, b) => b[1][1] - a[1][1]).slice(0, k).map(([key, [n, d, l]]) => `${r1(d)}ms n=${n} forcedLayout=${r1(l)} ${key}`);
}
function reactTop(commits, from = 0, to = 1e12, k = 12) {
  const agg = {}; let total = 0, n = 0, walk = 0;
  for (const c of commits) if (c.t >= from && c.t < to) { n++; total += c.total; walk += c.walk; for (const [name, [cnt, ms]] of Object.entries(c.agg)) { const a = (agg[name] = agg[name] || [0, 0]); a[0] += cnt; a[1] += ms; } }
  return { commits: n, renderMs: r1(total), hookOverheadMs: r1(walk), top: Object.entries(agg).sort((a, b) => b[1][1] - a[1][1]).slice(0, k).map(([nm, [c, ms]]) => `${nm}: ${r1(ms)}ms x${c}`) };
}
async function waitQuiet(page, quietMs = 800, max = 30000) {
  // network quiet: no request in flight for quietMs
  return page.evaluate(([q, max]) => new Promise((res) => { const t0 = performance.now(); let last = performance.now(), lastN = -1;
    const f = () => { const r = performance.getEntriesByType('resource'); const inflight = r.filter((e) => !e.responseEnd).length; const n = r.length;
      if (n !== lastN || inflight) { lastN = n; last = performance.now(); }
      const end = r.reduce((a, e) => Math.max(a, e.responseEnd || 0), 0);
      if (performance.now() - last > q || performance.now() - t0 > max) return res(end); setTimeout(f, 50); }; f(); }), [quietMs, max]);
}
function apiSummary(rs, from = 0, to = 1e12) {
  const api = rs.filter((r) => isApi(r.u) && r.s >= from && r.s < to);
  const cnt = {}; api.forEach((r) => (cnt[r.u] = (cnt[r.u] || 0) + 1));
  return { n: api.length, kb: r1(api.reduce((a, r) => a + r.tx, 0) / 1024), decKB: r1(api.reduce((a, r) => a + r.dec, 0) / 1024),
    dup: Object.entries(cnt).filter(([, c]) => c > 1).map(([u, c]) => `${u} x${c}`),
    slow: api.map((r) => ({ u: r.u.slice(0, 70), ms: r1(r.e - r.s), kb: r1(r.dec / 1024) })).sort((a, b) => b.ms - a.ms).slice(0, 5),
    lastEnd: r1(Math.max(0, ...api.map((r) => r.e - from))) };
}

// ---------------- scenarios ----------------
async function bootOnce(browser, warm) {
  const { ctx, page, cdp } = await newPage(browser, opt.device);
  if (warm) { await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await page.evaluate(() => new Promise((r) => { const f = () => (__P.boot.allVis ? r() : setTimeout(f, 50)); f(); })); await waitQuiet(page); }
  const resp = warm ? page.reload() : page.goto(BASE + '/');
  await resp;
  await page.waitForSelector('[data-tile-index] img', { timeout: 30000 });
  await page.evaluate(() => new Promise((r) => { const t = performance.now(); const f = () => (__P.boot.allVis || performance.now() - t > 20000 ? r() : setTimeout(f, 50)); f(); }));
  const quiet = await waitQuiet(page, 1500);
  const d = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, P: __P }; });
  const rs = await res(page);
  const P = d.P;
  const thumbs = rs.filter((r) => isThumb(r.u));
  const api = apiSummary(rs);
  const find = (re) => rs.find((r) => re.test(r.u));
  const onb = find(/\/api\/v1\/onboarding/), feed = find(/\/api\/v1\/images\?/), js = find(/\/assets\/index-.*\.js/), vendor = find(/\/assets\/vendor-.*\.js/), firstApi = rs.filter((r) => isApi(r.u)).sort((a, b) => a.s - b.s)[0];
  const out = { warm, ttfb: r1(d.ttfb), fcp: r1(P.paint['first-contentful-paint']), lcp: r1(P.lcp.length ? P.lcp[P.lcp.length - 1][0] : null), lcpEl: P.lcp.length ? P.lcp[P.lcp.length - 1][2] : '', dcl: r1(d.dcl),
    firstTile: r1(P.boot.firstTile), first12Loaded: r1(P.boot.first12), allVisibleLoaded: r1(P.boot.allVis), nVisible: P.boot.nVis, netQuiet: r1(quiet),
    jsEnd: r1(Math.max(js ? js.e : 0, vendor ? vendor.e : 0)), firstApiStart: r1(firstApi && firstApi.s), onboardingEnd: r1(onb && onb.e), feedStart: r1(feed && feed.s), feedEnd: r1(feed && feed.e), feedDur: r1(feed && feed.e - feed.s),
    gapOnbToFeed: r1(onb && feed ? feed.s - onb.e : null),
    thumbs: thumbs.length, thumbKB: r1(thumbs.reduce((a, r) => a + r.tx, 0) / 1024), thumbMedMs: r1(med(thumbs.map((r) => r.e - r.s))), thumbMedQueue: r1(med(thumbs.map((r) => r.q))), proto: thumbs[0] && thumbs[0].p,
    assetsKB: r1(rs.filter((r) => r.u.startsWith('/assets/')).reduce((a, r) => a + r.tx, 0) / 1024),
    api, lt: ltStats(P.lt, 0, quiet + 1), loafTop: loafTop(P.loaf, 0, quiet + 1, 6),
    waterfall: rs.filter((r) => !isThumb(r.u)).sort((a, b) => a.s - b.s).map((r) => `${r1(r.s)}..${r1(r.e)} q${r1(r.q)} ${r.u.slice(0, 80)} ${r1(r.tx / 1024)}KB`) };
  if (opt.react) out.react = reactTop(P.commits, 0, quiet + 1, 14);
  out.heap = await heap(cdp);
  await ctx.close();
  return out;
}

async function scrollOnce(browser) {
  const { ctx, page, cdp } = await newPage(browser, opt.device);
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-tile-index] img');
  await page.evaluate(() => new Promise((r) => { const t = performance.now(); const f = () => (__P.boot.allVis || performance.now() - t > 20000 ? r() : setTimeout(f, 50)); f(); }));
  await waitQuiet(page, 1000);
  const h0 = await heap(cdp);
  await page.evaluate(() => (window.__REC_ON = 1));
  const speed = +(opt.speed || 6000), target = +(opt.target || 2000), maxMs = +(opt.maxMs || 90000);
  const s = await page.evaluate(([speed, target, maxMs]) => new Promise((resolve) => {
    const sc = __scroller(); const t0 = performance.now(); let last = t0; const fr = []; let blankMs = 0, blankFrames = 0, seen = 0, un = 0, bottomMs = 0, maxIdx = 0, pos = sc.scrollTop;
    const pages = []; let nItems = 0;
    const f = () => {
      const t = performance.now(); const dt = t - last; last = t;
      fr.push([t, dt]);
      const v = __vis(); const u = v.filter((i) => !__loaded(i)).length; seen += v.length; un += u;
      if (u) { blankFrames++; blankMs += dt * (u / v.length); }
      const before = sc.scrollTop; pos += speed * dt / 1000; sc.scrollTop = pos; if (sc.scrollTop < pos - 2) { bottomMs += dt; pos = sc.scrollTop; }
      document.querySelectorAll('[data-tile-index]').forEach((e) => { const i = +e.dataset.tileIndex; if (i > maxIdx) maxIdx = i; });
      if (maxIdx >= target || t - t0 > maxMs) return resolve({ t0, t1: t, fr, blankMs, blankFrames, blankPct: seen ? (100 * un) / seen : 0, bottomMs, maxIdx, top: sc.scrollTop });
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }), [speed, target, maxMs]);
  await page.evaluate(() => (window.__REC_ON = 0));
  // settle: how long until visible tiles all loaded after stop
  const settle = await page.evaluate(() => new Promise((r) => { const t0 = performance.now(); const f = () => { const v = __vis(); if ((v.length && v.every(__loaded)) || performance.now() - t0 > 20000) return r(performance.now() - t0); requestAnimationFrame(f); }; f(); }));
  await page.waitForTimeout(500);
  const h1 = await heap(cdp);
  const P = await page.evaluate(() => __P);
  const rs = await res(page);
  const dts = s.fr.map(([, dt]) => dt).slice(1);
  const win = rs.filter((r) => r.s >= s.t0 && r.s <= s.t1);
  const th = win.filter((r) => isThumb(r.u));
  const feeds = rs.filter((r) => /\/api\/v1\/images\?/.test(r.u) && r.s >= s.t0 - 1);
  // in-flight thumbs per frame
  const infl = s.fr.filter((_, i) => i % 5 === 0).map(([t]) => th.filter((r) => r.s <= t && (r.e || 1e12) > t).length);
  const dur = s.t1 - s.t0;
  const out = { device: opt.device || 'desktop', speed, durMs: r1(dur), reachedIdx: s.maxIdx, scrolledPx: Math.round(s.top), effPxPerS: Math.round(s.top / (dur / 1000)),
    bottomWaitMs: r1(s.bottomMs), blankPct: r1(s.blankPct), blankFramePct: r1((100 * s.blankFrames) / s.fr.length), blankTileMs: r1(s.blankMs), settleAfterStop: r1(settle),
    frames: dts.length, fps: r1(dts.length / (dur / 1000)), p50Frame: r1(pct(dts, 0.5)), p95Frame: r1(pct(dts, 0.95)), maxFrame: r1(Math.max(...dts)), janky33: dts.filter((d) => d > 33.4).length, janky50: dts.filter((d) => d > 50).length,
    lt: ltStats(P.lt, s.t0, s.t1), loafTop: loafTop(P.loaf, s.t0, s.t1, 8), loafRenderMs: r1(P.loaf.filter((f) => f.s >= s.t0 && f.s < s.t1).reduce((a, f) => a + f.r, 0)),
    thumbReqs: th.length, thumbMB: r1(th.reduce((a, r) => a + r.tx, 0) / 1e6), thumbMedMs: r1(med(th.map((r) => r.e - r.s))), thumbP95Ms: r1(pct(th.map((r) => r.e - r.s), 0.95)), thumbMedQueue: r1(med(th.map((r) => r.q))), inflightMed: med(infl), inflightMax: Math.max(0, ...infl),
    feedPages: feeds.length, feedMedMs: r1(med(feeds.map((r) => r.e - r.s))), feedMaxMs: r1(Math.max(0, ...feeds.map((r) => r.e - r.s))), feedMedQueue: r1(med(feeds.map((r) => r.q))), feedMaxQueue: r1(Math.max(0, ...feeds.map((r) => r.q))),
    otherApi: apiSummary(rs, s.t0, s.t1 + 1000), heap0: h0, heap1: h1, heapGrowthMB: r1(h1.heapMB - h0.heapMB), nodesGrowth: h1.nodes - h0.nodes };
  if (opt.react) out.react = reactTop(P.commits, s.t0, s.t1);
  if (opt.dump) fs.writeFileSync(`${OUT}/scroll-${out.device}-${Date.now()}.json`, JSON.stringify({ s: { ...s, fr: s.fr }, feeds, loaf: P.loaf.filter((f) => f.s >= s.t0 && f.s < s.t1) }));
  await ctx.close();
  return out;
}

async function viewerOnce(browser) {
  const { ctx, page, cdp } = await newPage(browser, opt.device);
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-tile-index] img');
  await page.evaluate(() => new Promise((r) => { const t = performance.now(); const f = () => (__P.boot.allVis || performance.now() - t > 20000 ? r() : setTimeout(f, 50)); f(); }));
  await waitQuiet(page, 1000);
  const h0 = await heap(cdp);
  await page.evaluate(() => (window.__REC_ON = 1));
  // in-page waiter: URL change + main image shown
  const arm = () => page.evaluate(() => { const old = location.pathname; window.__step = new Promise((res) => { const t0 = performance.now(); let tUrl = 0, tThumb = 0;
    const f = () => { const t = performance.now(); if (!tUrl && location.pathname !== old && location.pathname.startsWith('/image/')) tUrl = t;
      const img = document.querySelector('img[alt="image"]'); const th = img && img.previousElementSibling;
      const id = location.pathname.slice(7);
      if (tUrl && !tThumb && th && th.tagName === 'IMG' && th.complete && th.naturalWidth) tThumb = t;
      if (tUrl && img && img.getAttribute('src') && img.getAttribute('src').includes(id) && img.complete && img.naturalWidth > 0 && /\bopacity-100\b/.test(img.className)) return res({ t0, url: tUrl - t0, thumb: tThumb ? tThumb - t0 : null, shown: t - t0 });
      if (t - t0 > 15000) return res({ t0, url: tUrl - t0, shown: null, timeout: true }); requestAnimationFrame(f); }; f(); }); });
  const steps = [];
  await arm();
  const tOpen = await page.evaluate(() => performance.now());
  await page.locator('[data-tile-index="0"] img').click();
  const open = await page.evaluate(() => __step);
  await page.waitForTimeout(300);
  for (let i = 0; i < 20; i++) {
    await arm();
    await page.keyboard.press('ArrowRight');
    const st = await page.evaluate(() => __step);
    steps.push(st);
    await page.waitForTimeout(+(opt.dwell || 150));
  }
  const tEnd = await page.evaluate(() => performance.now());
  await page.waitForTimeout(500);
  const closeT = await page.evaluate(() => new Promise((res) => { const t0 = performance.now(); history.back(); const f = () => { const v = __vis(); if (!location.pathname.startsWith('/image/') && v.length && v.every(__loaded)) return res(performance.now() - t0); if (performance.now() - t0 > 10000) return res(null); requestAnimationFrame(f); }; f(); }));
  await page.waitForTimeout(300);
  const h1 = await heap(cdp);
  const P = await page.evaluate(() => __P);
  const rs = await res(page);
  // per-step requests
  const per = steps.map((st, i) => { const to = i + 1 < steps.length ? steps[i + 1].t0 : tEnd; const w = rs.filter((r) => r.s >= st.t0 && r.s < to);
    return { api: w.filter((r) => isApi(r.u)).length, thumb: w.filter((r) => isThumb(r.u)).length, file: w.filter((r) => /\/file(\?|$)/.test(r.u)).length, kb: w.reduce((a, r) => a + r.tx, 0) / 1024, lt: ltStats(P.lt, st.t0, to).sum }; });
  const shown = steps.map((x) => x.shown);
  const stepWin = rs.filter((r) => r.s >= tOpen && r.s < tEnd);
  const cnt = {}; stepWin.filter((r) => isApi(r.u)).forEach((r) => { const k = r.u.replace(/(images|remix)\/[^/?]+/, '$1/:id').replace(/cursor=[^&]+/, 'cursor=…').replace(/(\?.{0,60}).*/, '$1'); cnt[k] = (cnt[k] || 0) + 1; });
  const out = { open: open, stepShownMed: r1(med(shown)), stepShownP90: r1(pct(shown.filter((x) => x != null), 0.9)), stepShownMax: r1(Math.max(...shown.filter((x) => x != null))), stepUrlMed: r1(med(steps.map((x) => x.url))), timeouts: steps.filter((x) => x.timeout).length,
    stepsShown: shown.map(r1), apiPerStep: r1(med(per.map((p) => p.api))), filePerStep: r1(med(per.map((p) => p.file))), thumbPerStep: r1(med(per.map((p) => p.thumb))), kbPerStep: r1(med(per.map((p) => p.kb))), ltPerStepMs: r1(med(per.map((p) => p.lt))),
    apiByRoute: cnt, fileMedMs: r1(med(stepWin.filter((r) => /\/file(\?|$)/.test(r.u)).map((r) => r.e - r.s))), fileMedKB: r1(med(stepWin.filter((r) => /\/file(\?|$)/.test(r.u)).map((r) => r.tx / 1024))),
    apiMedQueue: r1(med(stepWin.filter((r) => isApi(r.u)).map((r) => r.q))), apiMaxQueue: r1(Math.max(0, ...stepWin.filter((r) => isApi(r.u)).map((r) => r.q))),
    closeToGalleryMs: r1(closeT), lt: ltStats(P.lt, tOpen, tEnd), loafTop: loafTop(P.loaf, tOpen, tEnd, 8), heapGrowthMB: r1(h1.heapMB - h0.heapMB), heap1: h1 };
  if (opt.react) out.react = reactTop(P.commits, tOpen, tEnd);
  await ctx.close();
  return out;
}

// Default page list; the character page is the library's most-used character
// (looked up at start, see main).
let PAGES = (opt.pages || '/overview,/tags,/settings,/generate,/outfits,/libraries,/ai-tagging').split(',');
async function addCharacterPage() {
  if (opt.pages) return;
  try {
    const list = await (await fetch(BASE + '/api/v1/tags/characters')).json();
    const top = list.sort((a, b) => b.count - a.count)[0];
    if (top) PAGES.splice(2, 0, '/characters/' + encodeURIComponent(top.tag));
  } catch {}
}
async function pagesOnce(browser) {
  const out = {};
  for (const path of PAGES) {
    // (a) direct load, fresh context
    { const { ctx, page, cdp } = await newPage(browser, opt.device);
      await page.goto(BASE + path);
      const q = await waitQuiet(page, 1000);
      const P = await page.evaluate(() => __P); const rs = await res(page);
      const failed = rs.filter((r) => isApi(r.u) && r.tx === 0 && r.dec === 0).length;
      out[path] = { direct: { quietMs: r1(q), fcp: r1(P.paint['first-contentful-paint']), lcp: r1(P.lcp.length ? P.lcp[P.lcp.length - 1][0] : null), lt: ltStats(P.lt, 0, q + 1), api: apiSummary(rs), thumbs: rs.filter((r) => isThumb(r.u)).length, failedApi: failed, loafTop: loafTop(P.loaf, 0, q + 1, 4), heap: (await heap(cdp)).heapMB } };
      await ctx.close(); }
    // (b) in-app nav from a booted gallery
    { const { ctx, page, cdp } = await newPage(browser, opt.device);
      await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await waitQuiet(page, 1000);
      await page.evaluate(() => (window.__REC_ON = 1));
      const t0 = await page.evaluate((p) => { const t = performance.now(); history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return t; }, path);
      const q = await waitQuiet(page, 1000);
      await page.evaluate(() => (window.__REC_ON = 0));
      const P = await page.evaluate(() => __P); const rs = await res(page);
      out[path].nav = { quietMs: r1(Math.max(0, q - t0)), lt: ltStats(P.lt, t0, t0 + 30000), api: apiSummary(rs, t0), thumbs: rs.filter((r) => isThumb(r.u) && r.s >= t0).length, loafTop: loafTop(P.loaf, t0, t0 + 30000, 5) };
      if (opt.react) out[path].nav.react = reactTop(P.commits, t0, t0 + 30000, 8);
      await ctx.close(); }
  }
  return out;
}

async function typingOnce(browser) {
  const out = {};
  const text = opt.text || 'long hair';
  const keyStats = (P, t0) => { const k = P.keys.filter((x) => true); const ev = P.ev.filter((e) => e.s >= t0 && (e.n === 'keydown' || e.n === 'keypress' || e.n === 'keyup' || e.n === 'input' || e.n === 'beforeinput'));
    const byId = {}; ev.forEach((e) => { if (e.id) byId[e.id] = Math.max(byId[e.id] || 0, e.d); });
    const inter = Object.values(byId); return { keys: k.length, nextFrameMed: r1(med(k.map((x) => x.ms))), nextFrameMax: r1(Math.max(0, ...k.map((x) => x.ms))), nextFrame: k.map((x) => r1(x.ms)), eventTimingOver16: inter.length, eventTimingMax: Math.max(0, ...inter), lt: ltStats(P.lt, t0) }; };
  // (1) search palette on the gallery
  { const { ctx, page } = await newPage(browser, opt.device);
    await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await waitQuiet(page, 1000);
    await page.keyboard.press('Control+k'); await page.getByPlaceholder('Search characters, tags, images, pages…').waitFor(); await waitQuiet(page, 800);
    const t0 = await page.evaluate(() => { __P.keys.length = 0; window.__REC_ON = 1; return performance.now(); });
    await page.keyboard.type(text, { delay: +(opt.delay || 80) }); await page.waitForTimeout(600);
    const P = await page.evaluate(() => __P); out.palette = keyStats(P, t0); out.palette.loafTop = loafTop(P.loaf, t0, 1e12, 5); if (opt.react) out.palette.react = reactTop(P.commits, t0, 1e12, 8);
    await ctx.close(); }
  // (2) gallery toolbar tag search
  { const { ctx, page } = await newPage(browser, opt.device);
    await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await waitQuiet(page, 1000);
    const box = page.getByPlaceholder('Search tags, outfits, lora:, embedding:…'); await box.click(); await waitQuiet(page, 500);
    const t0 = await page.evaluate(() => { __P.keys.length = 0; window.__REC_ON = 1; return performance.now(); });
    await page.keyboard.type(text, { delay: +(opt.delay || 80) }); await page.waitForTimeout(600);
    const P = await page.evaluate(() => __P); out.gallerySearch = keyStats(P, t0); out.gallerySearch.loafTop = loafTop(P.loaf, t0, 1e12, 5); if (opt.react) out.gallerySearch.react = reactTop(P.commits, t0, 1e12, 8);
    await ctx.close(); }
  // (3) tags page filter
  { const { ctx, page } = await newPage(browser, opt.device);
    await page.goto(BASE + '/tags'); await waitQuiet(page, 1000);
    const box = page.getByPlaceholder('Filter tags…'); await box.click();
    const t0 = await page.evaluate(() => { __P.keys.length = 0; window.__REC_ON = 1; return performance.now(); });
    await page.keyboard.type(text, { delay: +(opt.delay || 80) }); await page.waitForTimeout(600);
    const P = await page.evaluate(() => __P); out.tagsFilter = keyStats(P, t0); out.tagsFilter.loafTop = loafTop(P.loaf, t0, 1e12, 5); if (opt.react) out.tagsFilter.react = reactTop(P.commits, t0, 1e12, 8);
    await ctx.close(); }
  return out;
}

async function coverageOnce(browser) {
  const { ctx, page } = await newPage(browser, opt.device);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(BASE + (opt.path || '/'));
  if ((opt.path || '/') === '/') await page.waitForSelector('[data-tile-index] img');
  await waitQuiet(page, 1500);
  const cov = await page.coverage.stopJSCoverage();
  const out = {};
  for (const e of cov) { if (!e.url.includes('/assets/')) continue; const src = e.source || ''; const mark = new Uint8Array(src.length);
    const ranges = e.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) mark.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
    let used = 0; for (let i = 0; i < mark.length; i++) used += mark[i];
    out[e.url.replace(/.*\//, '')] = { bytes: src.length, used, unusedPct: r1(100 - (100 * used) / src.length) }; }
  await ctx.close();
  return out;
}

(async () => {
  const gpuArgs = ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'];
  const browser = await chromium.launch(opt.gpu === '0' ? { args: (opt.args || '').split(' ').filter(Boolean) } : { channel: 'chromium', args: [...gpuArgs, ...(opt.args || '').split(' ').filter(Boolean)] });
  if (scenario === 'pages') await addCharacterPage();
  const fn = { boot: (b) => bootOnce(b, opt.warm === '1'), scroll: scrollOnce, viewer: viewerOnce, pages: pagesOnce, typing: typingOnce, coverage: coverageOnce }[scenario];
  const all = [];
  for (let i = 0; i < RUNS; i++) { const r = await fn(browser); all.push(r); console.log('RUN ' + JSON.stringify(r)); }
  fs.writeFileSync(`${OUT}/${scenario}-${opt.device || 'desktop'}${opt.warm === '1' ? '-warm' : ''}${opt.gpu === '0' ? '-swgl' : ''}${opt.net ? '-' + opt.net : ''}${opt.nofade ? '-nofade' : ''}${opt.thumb ? '-thumb' + opt.thumb : ''}${opt.nosib ? '-nosib' + (opt.nosib === 'replace' ? 'R' : '') : ''}${opt.fade ? '-fade' + opt.fade : ''}${opt.cpu ? '-cpu' + opt.cpu : ''}${opt.tag ? '-' + opt.tag : ''}-${Date.now()}.json`, JSON.stringify(all));
  // numeric summary: median [min..max] for every top-level number
  const sum = {};
  const walk = (objs, pre) => { const o = objs[0]; if (!o || typeof o !== 'object') return; for (const k of Object.keys(o)) { const vals = objs.map((x) => x && x[k]);
    if (typeof o[k] === 'number') { const v = vals.filter((x) => typeof x === 'number'); sum[pre + k] = `${r1(med(v))} [${r1(Math.min(...v))}..${r1(Math.max(...v))}]`; }
    else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) walk(vals, pre + k + '.'); } };
  walk(all, '');
  console.log('SUMMARY ' + JSON.stringify(sum, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
