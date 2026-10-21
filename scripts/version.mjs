#!/usr/bin/env node
// One version for the whole app. The backend's pyproject.toml is the source of
// truth (the wheel ships the built UI, so it *is* the app); both package.json
// files mirror it so nothing disagrees.
//
//   node scripts/version.mjs              print the current version
//   node scripts/version.mjs set 0.2.0    write it everywhere (+ uv.lock)
//   node scripts/version.mjs check v0.2.0 fail unless every file says 0.2.0
//
// `set` also rewrites the project's own entry in uv.lock: a pyproject bump
// without it breaks `uv sync --locked`. Only that line, so a release never
// re-resolves dependencies. Plain x.y.z only; npm and PEP 440 spell
// prereleases differently.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "packages/backend");
const packageJsons = ["package.json", "packages/frontend/package.json"];
const SEMVER = /^\d+\.\d+\.\d+$/;

function pyprojectVersion() {
  const text = readFileSync(join(backend, "pyproject.toml"), "utf8");
  const m = text.match(/^\[project\][^[]*?^version\s*=\s*"([^"]+)"/ms);
  if (!m) throw new Error("no [project] version in pyproject.toml");
  return m[1];
}

// The PyPI name, e.g. "moire-gallery": it keys the project's own uv.lock entry.
function distName() {
  const text = readFileSync(join(backend, "pyproject.toml"), "utf8");
  const m = text.match(/^\[project\][^[]*?^name\s*=\s*"([^"]+)"/ms);
  if (!m) throw new Error("no [project] name in pyproject.toml");
  return m[1];
}

const PYPROJECT_VERSION = /^(\[project\][^[]*?^version\s*=\s*")[^"]+(")/ms;
const lockPattern = () =>
  new RegExp(`^(name = "${distName()}"\\nversion = ")[^"]+(")`, "m");

function lockVersion() {
  const text = readFileSync(join(backend, "uv.lock"), "utf8");
  const m = text.match(lockPattern());
  return m ? text.slice(m.index + m[1].length).split('"')[0] : null;
}

function rewrite(file, pattern, version) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`no version found in ${file}`);
  writeFileSync(file, text.replace(pattern, `$1${version}$2`));
}

function readVersions() {
  const found = {
    "packages/backend/pyproject.toml": pyprojectVersion(),
    "packages/backend/uv.lock": lockVersion(),
  };
  for (const p of packageJsons) {
    found[p] = JSON.parse(readFileSync(join(root, p), "utf8")).version;
  }
  return found;
}

function set(version) {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  rewrite(join(backend, "pyproject.toml"), PYPROJECT_VERSION, version);
  rewrite(join(backend, "uv.lock"), lockPattern(), version);
  // In place, to keep each file's own indentation and key order.
  for (const p of packageJsons) {
    rewrite(join(root, p), /("version"\s*:\s*")[^"]*(")/, version);
  }
  check(version);
}

function check(expected) {
  const found = readVersions();
  const want = expected ?? found["packages/backend/pyproject.toml"];
  const wrong = Object.entries(found).filter(([, v]) => v !== want);
  for (const [file, v] of Object.entries(found)) {
    console.log(`${v === want ? "ok " : "BAD"} ${file}: ${v}`);
  }
  if (wrong.length) {
    console.error(`expected ${want} everywhere`);
    process.exit(1);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (!cmd) console.log(pyprojectVersion());
else if (cmd === "set" && arg) set(arg);
else if (cmd === "check") check(arg?.replace(/^v/, ""));
else {
  console.error("usage: version.mjs [set <x.y.z> | check [vX.Y.Z]]");
  process.exit(2);
}
