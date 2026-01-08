import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, build } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { builtinModules } from "node:module";

const externalDeps = [
  "better-sqlite3",
  "chokidar",
  "fsevents",
  "pino",
  "pino-pretty",
  "@tus/server",
  "@tus/file-store",
  "@tus/utils",
  "openai",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

// Custom plugin to build server modules as separate entry points after SSR build
function buildServerModulesPlugin() {
  let hasRun = false;

  return {
    name: "build-server-modules",
    apply: "build" as const,
    async closeBundle() {
      // Only run once (after the final build phase)
      if (hasRun) return;
      if (process.env.npm_lifecycle_event !== "build") return;
      hasRun = true;

      // Build init.ts and worker files separately
      const serverModules = [
        { entry: "app/.server/init.ts", outDir: "build/server", fileName: "init.js" },
        { entry: "app/.server/workers/fs/worker.ts", outDir: "build/server/workers/fs", fileName: "worker.js" },
        { entry: "app/.server/workers/digest/worker.ts", outDir: "build/server/workers/digest", fileName: "worker.js" },
      ];

      for (const { entry, outDir, fileName } of serverModules) {
        await build({
          configFile: false,
          plugins: [tsconfigPaths()],
          build: {
            ssr: true,
            outDir,
            emptyOutDir: false,
            lib: {
              entry,
              formats: ["es"],
              fileName: () => fileName,
            },
            rollupOptions: {
              external: externalDeps,
            },
          },
          logLevel: "warn",
        });
      }
    },
  };
}

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
    buildServerModulesPlugin(),
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
