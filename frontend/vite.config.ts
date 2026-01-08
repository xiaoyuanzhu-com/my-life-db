/**
 * Vite configuration for client-only SPA build
 *
 * This config builds the React app as a static SPA to be served by the Go backend.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],

  // Output to dist for Go server
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1000, // Suppress warning for main bundle (948KB is fine for personal app)

    rollupOptions: {
      input: {
        main: "index.html",
      },
      output: {
        // Use content hashes for cache busting
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",

        // Manual chunk configuration
        manualChunks: (id) => {
          // Keep large libraries separate for lazy loading
          if (id.includes('pdfjs-dist')) {
            return 'pdf-viewer';
          }
          if (id.includes('epubjs')) {
            return 'epub-viewer';
          }

          // Everything else goes into main bundle (no splitting)
          // This includes: routes, components, icons, content viewers, inbox-feed
          return undefined;
        },
      },
    },
  },

  server: {
    port: 3000,
    // Proxy API requests to Go backend during development
    proxy: {
      "/api": {
        target: "http://localhost:12345",
        changeOrigin: true,
      },
      "/raw": {
        target: "http://localhost:12345",
        changeOrigin: true,
      },
      "/sqlar": {
        target: "http://localhost:12345",
        changeOrigin: true,
      },
    },
  },

  // Copy static files to output
  publicDir: "static",

  // Optimize deps
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router",
      "@tanstack/react-query",
    ],
  },
});
