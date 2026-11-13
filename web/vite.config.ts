import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    // Inlined data: URIs (fonts especially) would be blocked by the CSP.
    assetsInlineLimit: 0,
    target: "es2022",
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:3030" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
