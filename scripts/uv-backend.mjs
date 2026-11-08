#!/usr/bin/env node
// `uv --directory packages/backend <args>`, keeping whichever onnxruntime build
// the backend venv already has.
//
// The CPU build sits in the default `cpu` dependency group, so a plain `uv run`
// installs it again even after `sync --group gpu`. The two builds share one
// `onnxruntime/` package folder, so the CPU build then wins and tagging falls
// back to the CPU with no error. Here a venv that has `onnxruntime-gpu` keeps
// it: `run` and `sync` get `--no-group cpu --group gpu`, and a `run` that finds
// both builds installed restores the GPU one first. An explicit UV_NO_GROUP in
// the environment is left to uv.
//
// Usage: node scripts/uv-backend.mjs run pytest -x
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/backend");

function sitePackages() {
  const venv = join(backend, ".venv");
  const win = join(venv, "Lib", "site-packages");
  if (existsSync(win)) return [win];
  const lib = join(venv, "lib");
  if (!existsSync(lib)) return [];
  return readdirSync(lib)
    .filter((d) => d.startsWith("python"))
    .map((d) => join(lib, d, "site-packages"));
}

function installed(prefix) {
  return sitePackages().some(
    (dir) => existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith(".dist-info")),
  );
}

const GPU = ["--no-group", "cpu", "--group", "gpu"];
const [cmd, ...rest] = process.argv.slice(2);
const keepGpu = (cmd === "run" || cmd === "sync") && !process.env.UV_NO_GROUP && installed("onnxruntime_gpu-");

// A plain `uv run` since the GPU install put the CPU build back over it:
// put the GPU build back first (the README's repair command).
if (keepGpu && cmd === "run" && installed("onnxruntime-")) {
  console.error("uv-backend: the CPU onnxruntime build was installed over the GPU one; restoring the GPU build");
  const fix = spawnSync("uv", ["--directory", backend, "sync", ...GPU, "--reinstall-package", "onnxruntime-gpu"], {
    stdio: "inherit",
  });
  if (fix.status !== 0) process.exit(fix.status ?? 1);
}

const args = ["--directory", backend, cmd, ...(keepGpu ? GPU : []), ...rest];

const child = spawn("uv", args, { stdio: "inherit" });
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of SIGNALS) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => {
  if (signal) {
    // Die of the same signal: drop our forwarders first, or it lands on them.
    for (const sig of SIGNALS) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
child.on("error", (e) => {
  console.error(`uv-backend: could not start uv: ${e.message}`);
  process.exit(1);
});
