/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@/` is src/: imports read the same from any depth.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // The backend serves the built UI from here (src/moire/web_ui.py), so a packaged
    // Moiré is one process. Gitignored; `uv build` still includes it.
    outDir: "../backend/src/moire/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Libraries change less often than the app: their own chunk stays
        // cached across releases.
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // jsdom workers are memory-heavy; the default (one per core) can exhaust RAM
    // on a full run. A fixed cap keeps the suite's footprint bounded.
    maxWorkers: 4,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
