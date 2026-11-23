#!/usr/bin/env node
// The files the wheel and sdist carry from outside packages/backend. A build
// backend only reads inside its own project, so these live there as copies:
//
//   packages/backend/README.md  the root README, PyPI's project page. Relative
//                               links and images point at GitHub at this
//                               version's tag, since PyPI serves no repo files.
//   packages/backend/LICENSE    the root LICENSE, as is.
//
//   node scripts/package-files.mjs          write both
//   node scripts/package-files.mjs check    fail if either is out of step
//
// version.mjs calls both (the README links name the version's tag).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "packages/backend");
const IMAGE = /\.(webp|png|jpe?g|gif|svg)$/i;

function project() {
  const text = readFileSync(join(backend, "pyproject.toml"), "utf8");
  const version = text.match(/^\[project\][^[]*?^version\s*=\s*"([^"]+)"/ms)?.[1];
  const repo = text.match(/^Repository\s*=\s*"https:\/\/github\.com\/([^"]+?)\/?"/m)?.[1];
  if (!version || !repo) throw new Error("pyproject.toml needs a version and a [project.urls] Repository");
  return { version, repo };
}

// One link target: absolute, mail and in-page anchors on PyPI's own page stay;
// a repo path goes to GitHub at the tag (raw for images, blob otherwise).
function absolute(target, { version, repo }) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const ref = `v${version}`;
  if (target.startsWith("#")) return `https://github.com/${repo}/blob/${ref}/README.md${target}`;
  const path = target.replace(/^\.\//, "");
  return IMAGE.test(path.split("#")[0])
    ? `https://raw.githubusercontent.com/${repo}/${ref}/${path}`
    : `https://github.com/${repo}/blob/${ref}/${path}`;
}

export function pypiReadme() {
  const info = project();
  const text = readFileSync(join(root, "README.md"), "utf8")
    .replace(/(!?\[[^\]]*\]\()([^)\s]+)/g, (_, head, t) => head + absolute(t, info))
    .replace(/\b(src|href)="([^"]+)"/g, (_, attr, t) => `${attr}="${absolute(t, info)}"`)
    // PyPI doesn't draw GitHub's alert boxes.
    .replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/gm, (_, kind) =>
      `> **${kind[0]}${kind.slice(1).toLowerCase()}**`);
  return `<!-- Made from the root README.md by scripts/package-files.mjs: edit that one. -->\n\n${text}`;
}

const files = () => ({
  "packages/backend/README.md": pypiReadme(),
  "packages/backend/LICENSE": readFileSync(join(root, "LICENSE"), "utf8"),
});

export function writeFiles() {
  for (const [file, text] of Object.entries(files())) writeFileSync(join(root, file), text);
}

export function checkFiles() {
  let ok = true;
  for (const [file, text] of Object.entries(files())) {
    let have = null;
    try {
      have = readFileSync(join(root, file), "utf8");
    } catch {}
    const same = have === text;
    ok &&= same;
    console.log(`${same ? "ok " : "BAD"} ${file}`);
  }
  if (!ok) console.error("run: node scripts/package-files.mjs");
  return ok;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "check") process.exit(checkFiles() ? 0 : 1);
  writeFiles();
}
