import { defineConfig, devices } from "@playwright/test";
import { BACKEND_PORT, COMFY_OUT, COMFY_PORT, MODEL_CACHE_DIR } from "./tests/helpers";

export default defineConfig({
  testDir: "tests",
  // One app, one DB: specs share state and run in order. No retries: a second
  // attempt meets what the first one changed and fails for the wrong reason.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${BACKEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    colorScheme: "dark",
    // E2E_SLOWMO=300 with --headed: slow enough to watch.
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO) || 0 },
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "chromium", dependencies: ["setup"], testIgnore: /tagging-ai/, use: { ...devices["Desktop Chrome"] } },
    // Last: AI tags land on fixture images other specs read exactly.
    { name: "ai", dependencies: ["chromium"], testMatch: /tagging-ai/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      // Never the real ComfyUI: the suite only ever talks to this fake.
      command: `uv --directory ../backend run uvicorn fake_comfy_server:app --app-dir ../e2e/servers --host 127.0.0.1 --port ${COMFY_PORT}`,
      url: `http://127.0.0.1:${COMFY_PORT}/system_stats`,
      env: { FAKE_COMFY_OUT: COMFY_OUT, FAKE_COMFY_RUN: "0.3" },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
    },
    {
      command: `uv --directory ../backend run python ../e2e/servers/start_backend.py`,
      url: `http://127.0.0.1:${BACKEND_PORT}/health`,
      env: { E2E_BACKEND_PORT: String(BACKEND_PORT), E2E_COMFY_OUT: COMFY_OUT, E2E_MODEL_CACHE_DIR: MODEL_CACHE_DIR },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
