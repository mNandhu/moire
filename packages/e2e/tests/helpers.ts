import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

// Ports away from `pnpm dev` (8000/5173) and the dev-tools sandbox (8010/8190/5180).
export const BACKEND_PORT = 8020;
export const COMFY_PORT = 8191;

/** Wiped and laid out on every run by `servers/start_backend.py`. */
export const SANDBOX_DIR = path.resolve(here, "../.sandbox");
/** Where the fake ComfyUI saves; Generate's output folder in the specs. */
export const COMFY_OUT = path.join(SANDBOX_DIR, "comfy-out");
/** The tagger model cache: kept between runs, outside the wiped sandbox. */
export const MODEL_CACHE_DIR = process.env.E2E_MODEL_CACHE_DIR || path.resolve(here, "../.models");

type Manifest = { images: number; dir: string };
let manifest: Manifest | undefined;

/** What `servers/start_backend.py` laid out: test_images plus filler, more
 * than one feed page. Read once the server has started. */
export function sandbox(): Manifest {
  manifest ??= JSON.parse(readFileSync(path.join(SANDBOX_DIR, "manifest.json"), "utf8")) as Manifest;
  return manifest;
}

export const API = "/api/v1";

type Library = { _id: string; path: string; scanning?: boolean; indexed_count?: number };

export async function libraries(request: APIRequestContext): Promise<Library[]> {
  const res = await request.get(`${API}/libraries`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Wait until no library is scanning and every image is indexed. */
export async function waitForScan(request: APIRequestContext, count = sandbox().images) {
  await expect
    .poll(
      async () => {
        const libs = await libraries(request);
        if (libs.some((l) => l.scanning)) return -1;
        return libs.reduce((n, l) => n + (l.indexed_count ?? 0), 0);
      },
      { timeout: 90_000, intervals: [500, 1000] },
    )
    .toBe(count);
}

type FeedRow = { _id: string; score?: number };

/** A fixture image by a piece of its path, e.g. "weighted/weighted.png". */
export async function imageByPath(request: APIRequestContext, part: string): Promise<FeedRow> {
  const res = await request.get(`${API}/images?limit=200`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const found = ((body.items ?? body) as FeedRow[]).find((i) => i._id.includes(part));
  if (!found) throw new Error(`no fixture image matching ${part}`);
  return found;
}

export const viewerUrl = (id: string) => `/image/${encodeURIComponent(id)}`;

/** One image's full row (tags included). */
export async function imageById(request: APIRequestContext, id: string): Promise<{ tags: string[]; score?: number }> {
  const res = await request.get(`${API}/images/${encodeURIComponent(id)}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}
