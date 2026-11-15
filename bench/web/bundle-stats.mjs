// Build the frontend into $BENCH_WORK/web/statsbuild and dump per-module rendered sizes per chunk.
// usage: node bundle-stats.mjs   (cwd anywhere)
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = join(process.env.BENCH_WORK || join(REPO, "local-setup", "bench"), "web");
const FE = join(REPO, "packages", "frontend");
const { build } = await import(pathToFileURL(createRequire(FE + "/").resolve("vite")).href);
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const OUT = join(WORK, "statsbuild");
const stats = {};
await build({
  root: FE, configFile: FE + "/vite.config.ts", logLevel: "warn",
  build: { outDir: OUT, emptyOutDir: true },
  plugins: [{ name: "stats", generateBundle(_, bundle) {
    for (const [f, c] of Object.entries(bundle)) if (c.type === "chunk") {
      stats[f] = { isEntry: c.isEntry, isDynamicEntry: c.isDynamicEntry, imports: c.imports, dynamicImports: c.dynamicImports,
        size: c.code.length, gzip: gzipSync(c.code).length,
        modules: Object.entries(c.modules).map(([id, m]) => [id.replace(/.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, "npm:").replace(FE + "/", ""), m.renderedLength]).sort((a, b) => b[1] - a[1]) };
    }
  } }],
});
writeFileSync(OUT + "/../bundle-stats.json", JSON.stringify(stats, null, 1));
for (const [f, s] of Object.entries(stats).sort((a, b) => b[1].size - a[1].size).slice(0, 4)) {
  console.log(`\n${f} ${s.size} B (gz ${s.gzip}) entry=${s.isEntry} imports=${s.imports.join(",")}`);
  for (const [m, n] of s.modules.slice(0, 25)) console.log(String(n).padStart(8), m);
}
// npm package totals
const pk = {};
for (const s of Object.values(stats)) for (const [m, n] of s.modules) { const k = m.startsWith("npm:") ? m.split("/").slice(0, m.startsWith("npm:@") ? 2 : 1).join("/") : (m.split("/").slice(0, 3).join("/")); pk[k] = (pk[k] || 0) + n; }
console.log("\nby package/dir:"); for (const [k, n] of Object.entries(pk).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(String(n).padStart(8), k);
