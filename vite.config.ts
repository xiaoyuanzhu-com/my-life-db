import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { builtinModules } from "node:module";

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  server: {
    port: 12345,
  },
  // Disable Vite's default public directory behavior to avoid warnings
  // Files in static/ directory will be served at /static/ (handled in server.js)
  publicDir: false,
  // Handle better-sqlite3 and other native modules
  build: {
    rollupOptions: {
      external: [
        // Only externalize for SSR builds
        ...(isSsrBuild
          ? [
              "better-sqlite3",
              "chokidar",
              "fsevents",
              "pino",
              "pino-pretty",
              // TUS upload server dependencies
              "@tus/server",
              "@tus/file-store",
              "@tus/utils",
              // Externalize all Node.js built-in modules for production server
              ...builtinModules,
              ...builtinModules.map((m) => `node:${m}`),
            ]
          : []),
      ],
      onLog(level, log, handler) {
        // Suppress "Generated an empty chunk" warnings for API routes (server-only routes)
        if (log.message?.includes("Generated an empty chunk")) return;
        handler(level, log);
      },
    },
  },
  // Optimize deps for client-side
  optimizeDeps: {
    exclude: ["better-sqlite3"],
  },
}));
