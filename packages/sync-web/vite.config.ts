import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const syncPort = Number(process.env.CINBA_SYNC_PORT) || 4518;

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: { "/api": { target: `http://127.0.0.1:${syncPort}` } },
  },
});
