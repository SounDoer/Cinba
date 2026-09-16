import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { developmentProxy } from "./src/development-proxy.ts";

const corePort = Number(process.env.CINBA_PORT) || 4517;

export default defineConfig({
  plugins: [react()],
  // Build output references assets relatively, so the server can serve it from any prefix.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // In development Vite owns the browser origin while Core owns both control surfaces.
    proxy: developmentProxy(corePort),
  },
});
