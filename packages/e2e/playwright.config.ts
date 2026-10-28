import { defineConfig, devices } from "@playwright/test";

// Ports away from `pnpm dev` (8000/5173) and the dev-tools sandbox (8010/8190/5180).
export const BACKEND_PORT = 8020;
export const COMFY_PORT = 8191;

export default defineConfig({
  testDir: "tests",
  // One app, one DB: specs share state and run in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${BACKEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    colorScheme: "dark",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "chromium", dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      // Never the real ComfyUI: the suite only ever talks to this fake.
      command: `uv --directory ../backend run uvicorn fake_comfy_server:app --app-dir ../e2e/servers --host 127.0.0.1 --port ${COMFY_PORT}`,
      url: `http://127.0.0.1:${COMFY_PORT}/system_stats`,
      env: { FAKE_COMFY_OUT: "../e2e/.sandbox/comfy-out", FAKE_COMFY_RUN: "0.3" },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
    },
    {
      command: `uv --directory ../backend run python ../e2e/servers/start_backend.py`,
      url: `http://127.0.0.1:${BACKEND_PORT}/health`,
      env: { E2E_BACKEND_PORT: String(BACKEND_PORT) },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
