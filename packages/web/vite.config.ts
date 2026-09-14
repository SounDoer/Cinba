import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const corePort = Number(process.env.CINBA_PORT) || 4517;

export default defineConfig({
  plugins: [react()],
  // Build output references assets relatively, so the server can serve it from any prefix.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // In development Vite serves the page, with hot reload, but the WebSocket goes to the core service.
    proxy: { "/ws": { target: `ws://127.0.0.1:${corePort}`, ws: true } },
  },
});
