import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 产物用相对路径引用资源，这样 core-server 从任意前缀提供都能工作。
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // 开发时页面由 Vite 提供（有热更新），但 WebSocket 要转给 core-server。
    proxy: { "/ws": { target: "ws://127.0.0.1:4517", ws: true } },
  },
});
