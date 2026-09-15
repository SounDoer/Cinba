import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "shell", "index.html"),
        manage: resolve(import.meta.dirname, "shell", "manage.html"),
      },
    },
  },
});
