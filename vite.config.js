import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer is served by Vite in dev (port 5173) and built to ./dist for packaging.
// base: "./" so the built index.html loads assets with relative paths under file://
//
// NOTE: electron-builder outputs INSTALLERS to ./release (build.directories.output
// in package.json), NOT ./dist. Keeping them separate is deliberate — vite's
// emptyOutDir wipes ./dist on every build, and when installers lived there it
// tried (and failed, EPERM) to delete the locked .exe from the prior build.
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
