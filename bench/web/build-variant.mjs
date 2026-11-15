// usage: node build-variant.mjs NAME   (NAME: prof | rrprod)
//  prof:   minify off, sourcemaps, react-dom/profiling (DevTools-hook commit timings)
//  rrprod: as shipped, but react-router resolved to its dist/production build
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = join(process.env.BENCH_WORK || join(REPO, "local-setup", "bench"), "web");
const FE = join(REPO, "packages", "frontend");
const { build } = await import(pathToFileURL(createRequire(FE + "/").resolve("vite")).href);
import { realpathSync } from "node:fs";
const name = process.argv[2];
const OUT = join(WORK, `build-${name}`);
const rr = realpathSync(FE + "/node_modules/react-router-dom") + "/../react-router";
const alias = name === "prof"
  ? [{ find: /^react-dom$/, replacement: realpathSync(FE + "/node_modules/react-dom") + "/profiling.js" }, { find: "scheduler/tracing", replacement: "scheduler/tracing-profiling" }]
  : [{ find: /^react-router$/, replacement: rr + "/dist/production/index.mjs" }, { find: /^react-router\/dom$/, replacement: rr + "/dist/production/dom-export.mjs" }];
await build({ root: FE, configFile: FE + "/vite.config.ts", logLevel: "info",
  resolve: { alias },
  build: { outDir: OUT, emptyOutDir: true, ...(name === "prof" ? { minify: false, sourcemap: true } : {}) } });
