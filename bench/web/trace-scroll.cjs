// Chrome trace of a gallery scroll; main-thread time by event type.
// usage: node trace-scroll.cjs SPEED SECONDS sampler(0|1) [device]
const { chromium, devices } = require('./paths.cjs').playwright();
const fs = require('fs');
const [speed, secs, sampler, device] = [+process.argv[2] || 6000, +process.argv[3] || 6, process.argv[4] === '1', process.argv[5] || 'desktop'];
const BASE = process.env.BASE || 'http://127.0.0.1:8820';
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
  const ctx = await b.newContext(device === 'phone' ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 900 } });
  if (process.env.NOSIB) await ctx.addInitScript({ path: __dirname + '/' + (process.env.NOSIB === 'replace' ? 'nosib-replace.js' : 'nosib.js') });
  const page = await ctx.newPage();
  await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await page.waitForTimeout(1500);
  const file = `${require('./paths.cjs').OUT}/trace-${device}-${speed}-${sampler ? 's' : 'n'}${process.env.NOSIB ? '-nosib' + process.env.NOSIB : ''}${process.env.INVAL ? '-inval' : ''}.json`;
  await b.startTracing(page, { path: file, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'v8.execute', 'toplevel', 'disabled-by-default-devtools.timeline.frame', ...(process.env.INVAL ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : [])] });
  await page.evaluate(([speed, secs, sampler]) => new Promise((res) => {
    let e = document.querySelector('[data-tile-index]'); while (e) { const c = getComputedStyle(e); if (/(auto|scroll)/.test(c.overflowY) && e.scrollHeight > e.clientHeight + 10) break; e = e.parentElement; }
    const sc = e || document.scrollingElement; const t0 = performance.now(); let last = t0, pos = sc.scrollTop;
    const f = () => { const t = performance.now(); pos += speed * (t - last) / 1000; last = t; sc.scrollTop = pos;
      if (sampler) document.querySelectorAll('[data-tile-index] img').forEach((i) => i.getBoundingClientRect());
      if (t - t0 > secs * 1000) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); }), [speed, secs, sampler]);
  await b.stopTracing();
  await b.close();
  // summarize renderer main thread
  const ev = JSON.parse(fs.readFileSync(file)).traceEvents;
  const main = ev.find((e) => e.name === 'thread_name' && e.args.name === 'CrRendererMain' && ev.some((x) => x.pid === e.pid && x.name === 'FunctionCall'));
  const pid = main.pid, tid = main.tid;
  const mine = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && e.dur);
  const top = mine.filter((e) => e.name === 'RunTask');
  const t0 = Math.min(...top.map((e) => e.ts)), t1 = Math.max(...top.map((e) => e.ts + e.dur));
  const busy = top.reduce((a, e) => a + e.dur, 0);
  const by = {}; for (const e of mine) if (e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask') by[e.name] = (by[e.name] || 0) + e.dur;
  console.log(JSON.stringify({ device, speed, secs, sampler, wallMs: Math.round((t1 - t0) / 1000), busyMs: Math.round(busy / 1000), busyPct: Math.round((100 * busy) / (t1 - t0)) }));
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(String(Math.round(v / 1000)).padStart(7), 'ms', k);
  // image decode on raster/decoder threads
  const dec = ev.filter((e) => /Decode|ImageDecode/i.test(e.name) && e.ph === 'X');
  const byT = {}; for (const e of dec) byT[e.name] = (byT[e.name] || 0) + e.dur;
  console.log('decode events (all threads):', Object.entries(byT).map(([k, v]) => `${k}=${Math.round(v / 1000)}ms`).join(' '));
})().catch((e) => { console.error(e); process.exit(1); });
