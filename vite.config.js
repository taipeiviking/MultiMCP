import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer is served by Vite in dev (port 5173) and built to ./dist for packaging.
// base: "./" so the built index.html loads assets with relative paths under file://
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
