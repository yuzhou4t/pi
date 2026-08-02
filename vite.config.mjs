import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.PI_API_TARGET ?? "http://127.0.0.1:8788";
const nodeTestContext = Boolean(process.env.NODE_TEST_CONTEXT);

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("/katex/")) return "katex";
          if (
            id.includes("/react-markdown/")
            || id.includes("/remark-")
            || id.includes("/rehype-")
            || id.includes("/unified/")
            || id.includes("/micromark")
            || id.includes("/mdast-util")
            || id.includes("/hast-util")
            || id.includes("/unist-util")
          ) {
            return "paper-markdown";
          }
          return undefined;
        },
      },
    },
  },
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
      clientFiles: nodeTestContext ? [] : ["./src/main.jsx"],
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
