import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  // Handle better-sqlite3 and other native modules
  build: {
    rollupOptions: {
      external: [
        "better-sqlite3",
        "chokidar",
        "fsevents",
        "pino",
        "pino-pretty",
      ],
    },
  },
  // Optimize deps for client-side
  optimizeDeps: {
    exclude: ["better-sqlite3"],
  },
});
