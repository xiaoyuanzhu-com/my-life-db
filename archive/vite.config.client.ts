/**
 * Vite configuration for client-only build (for Go server)
 *
 * This config builds the React app as a static SPA to be served by the Go server.
 * Run with: npm run build:client
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
  ],

  // Output to dist/client for Go server
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: false,

    rollupOptions: {
      input: {
        main: "index.html",
      },
      output: {
        // Use content hashes for cache busting
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
      onLog(level, log, handler) {
        // Suppress empty chunk warnings
        if (log.message?.includes("Generated an empty chunk")) return;
        handler(level, log);
      },
    },
  },

  // Disable SSR
  ssr: {
    noExternal: true,
  },

  server: {
    port: 3000,
  },

  publicDir: false,

  // Optimize deps
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router",
      "@tanstack/react-query",
    ],
  },

  // Define environment variables
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "development"),
  },
});
