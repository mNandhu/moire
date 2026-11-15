// How long does the viewer's commit-on-decode wait take for an already-preloaded neighbour?
const { chromium } = require('./paths.cjs').playwright();
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://127.0.0.1:8820/'); await p.waitForSelector('[data-tile-index] img'); await p.waitForTimeout(1000);
  const ids = await p.evaluate(async () => (await (await fetch('/api/v1/images?logic=and&limit=12')).json()).map((x) => [x._id, x.width, x.height]));
  await p.locator('[data-tile-index="0"] img').click(); await p.waitForTimeout(2500); // neighbours 1,2,3 preloaded + decoded
  const r = await p.evaluate(async (ids) => { const out = [];
    for (const [k, [id, w, h]] of ids.slice(1, 8).entries()) { const u = `/api/v1/images/${encodeURIComponent(id)}/file`;
      const t0 = performance.now(); const img = new Image(); img.src = u; await img.decode(); const t1 = performance.now();
      const img2 = new Image(); img2.src = u; await img2.decode(); const t2 = performance.now();
      out.push({ idx: k + 1, w, h, preloaded: k < 3, firstDecodeMs: +(t1 - t0).toFixed(1), againMs: +(t2 - t1).toFixed(1) }); }
    return out; }, ids);
  console.log(JSON.stringify(r));
  await b.close();
})();
