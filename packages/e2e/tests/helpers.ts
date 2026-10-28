import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The fixture library `servers/start_backend.py` lays out. */
export const IMAGES_DIR = path.resolve(here, "../.sandbox/images");
/** Six generated images plus filler; more than one feed page. */
export const IMAGE_COUNT = 6 + 120;

export const API = "/api/v1";

type Library = { _id: string; scanning?: boolean; indexed_count?: number };

export async function libraries(request: APIRequestContext): Promise<Library[]> {
  const res = await request.get(`${API}/libraries`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Wait until no library is scanning and every image is indexed. */
export async function waitForScan(request: APIRequestContext, count = IMAGE_COUNT) {
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
