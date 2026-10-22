/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
