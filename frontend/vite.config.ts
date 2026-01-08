/**
 * Vite configuration for client-only SPA build
 *
 * This config builds the React app as a static SPA to be served by the Go backend.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "fs";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
    // Plugin to move static files to static/ subdirectory after build
    {
      name: "move-static-files",
      closeBundle() {
        const distDir = path.resolve(__dirname, "dist");
        const staticDir = path.join(distDir, "static");

        // Create static directory if it doesn't exist
        if (!fs.existsSync(staticDir)) {
          fs.mkdirSync(staticDir, { recursive: true });
        }

        // List of static files to move to static/ subdirectory
        const staticFiles = [
          "favicon-16x16.png",
          "favicon-32x32.png",
          "apple-touch-icon.png",
          "android-chrome-192x192.png",
          "android-chrome-512x512.png",
          "my-life-db-logo.png",
        ];

        // Move each file
        staticFiles.forEach((file) => {
          const srcPath = path.join(distDir, file);
          const destPath = path.join(staticDir, file);
          if (fs.existsSync(srcPath)) {
            fs.renameSync(srcPath, destPath);
          }
        });

        // Update index.html to reference static/ path
        const indexPath = path.join(distDir, "index.html");
        if (fs.existsSync(indexPath)) {
          let html = fs.readFileSync(indexPath, "utf-8");
          staticFiles.forEach((file) => {
            html = html.replace(new RegExp(`"/${file}"`, "g"), `"/static/${file}"`);
            html = html.replace(new RegExp(`'/${file}'`, "g"), `'/static/${file}'`);
          });
          fs.writeFileSync(indexPath, html);
        }

        // Update manifest.webmanifest to reference static/ path for icons
        const manifestPath = path.join(distDir, "manifest.webmanifest");
        if (fs.existsSync(manifestPath)) {
          let manifest = fs.readFileSync(manifestPath, "utf-8");
          staticFiles.forEach((file) => {
            if (file.endsWith('.png')) {
              manifest = manifest.replace(new RegExp(`"/${file}"`, "g"), `"/static/${file}"`);
            }
          });
          fs.writeFileSync(manifestPath, manifest);
        }
      },
    },
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
        assetFileNames: (assetInfo) => {
          // Put static files (from public dir) in static/
          // Keep CSS and other build assets in assets/
          const info = assetInfo.names?.[0] || '';
          if (info.endsWith('.png') || info.endsWith('.svg') ||
              info.endsWith('.ico') || info.endsWith('.webmanifest')) {
            return 'static/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },

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
    port: 12346,
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
