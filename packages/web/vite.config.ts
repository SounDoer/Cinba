import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Build output references assets relatively, so the server can serve it from any prefix.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // In development Vite serves the page, with hot reload, but the WebSocket goes to the core service.
    proxy: { "/ws": { target: "ws://127.0.0.1:4517", ws: true } },
  },
});
