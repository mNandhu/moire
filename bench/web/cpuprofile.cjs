// CPU-sample a scenario on a (preferably unminified) build; self time by function.
// usage: BASE=http://127.0.0.1:8821 node cpuprofile.cjs boot|viewer|tagsfilter|palette|gallerysearch
const { chromium } = require('./paths.cjs').playwright();
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8821';
const what = process.argv[2] || 'boot';
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  const quiet = () => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(500));
  if (what === 'boot') { await cdp.send('Profiler.start'); await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await quiet(); }
  else if (what === 'viewer') { await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await quiet();
    await page.locator('[data-tile-index="0"] img').click(); await page.waitForTimeout(800); await cdp.send('Profiler.start');
    for (let i = 0; i < 20; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250); } }
  else if (what === 'tagsfilter') { await page.goto(BASE + '/tags'); await quiet(); await page.getByPlaceholder('Filter tags…').click(); await cdp.send('Profiler.start'); await page.keyboard.type('long hair', { delay: 80 }); await page.waitForTimeout(500); }
  else if (what === 'gallerysearch') { await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await quiet(); await page.getByPlaceholder('Search tags, outfits, lora:, embedding:…').click(); await cdp.send('Profiler.start'); await page.keyboard.type('long hair', { delay: 80 }); await page.waitForTimeout(500); }
  else if (what === 'palette') { await page.goto(BASE + '/'); await page.waitForSelector('[data-tile-index] img'); await quiet(); await page.keyboard.press('Control+k'); await page.waitForTimeout(800); await cdp.send('Profiler.start'); await page.keyboard.type('long hair', { delay: 80 }); await page.waitForTimeout(800); }
  const { profile } = await cdp.send('Profiler.stop');
  fs.writeFileSync(`${require('./paths.cjs').OUT}/cpu-${what}.cpuprofile`, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n])); const self = new Map();
  const dt = profile.timeDeltas; const cnt = new Map(); profile.samples.forEach((s, i) => cnt.set(s, (cnt.get(s) || 0) + (dt[i] || 0)));
  for (const [id, us] of cnt) { const n = byId.get(id); const cf = n.callFrame; const k = `${cf.functionName || '(anon)'} ${cf.url.replace(/.*\//, '')}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + us); }
  const tot = [...self.values()].reduce((a, b) => a + b, 0);
  const idle = [...self.entries()].filter(([k]) => /^\((idle|program|garbage collector)\)/.test(k));
  console.log(`== ${what}: total ${Math.round(tot / 1000)}ms sampled; ` + idle.map(([k, v]) => `${k.split(' ')[0]}=${Math.round(v / 1000)}ms`).join(' '));
  for (const [k, v] of [...self.entries()].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String((v / 1000).toFixed(1)).padStart(7), 'ms', k);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
