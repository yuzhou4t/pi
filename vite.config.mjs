import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.PI_API_TARGET ?? "http://127.0.0.1:8788";

export default defineConfig({
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    proxy: {
      "/api": apiTarget,
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
    },
  },
  plugins: [react()],
});
