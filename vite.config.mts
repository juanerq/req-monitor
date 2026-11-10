import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "web/app.ts",
      formats: ["iife"],
      name: "ReqMonitor",
      fileName: () => "app.js",
    },
  },
});
