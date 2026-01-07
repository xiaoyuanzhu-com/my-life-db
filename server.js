/**
 * Unified Server Entry Point
 *
 * Handles both development (with Vite HMR) and production modes.
 * Initializes application services on startup.
 */

import compression from "compression";
import express from "express";
import { createRequestHandler } from "@react-router/express";
import { networkInterfaces } from "os";

const PORT = process.env.PORT || 12345;
const HOST = process.env.HOST || '0.0.0.0';
const isDev = process.env.NODE_ENV !== "production";

async function main() {
  const app = express();

  // Trust proxy
  app.set("trust proxy", true);

  // Ignore Chrome DevTools and other well-known requests
  app.use("/.well-known", (_req, res) => {
    res.status(404).end();
  });

  // Serve public directory at /static/ prefix BEFORE Vite middleware
  // This avoids Vite warnings while maintaining JWT bypass at gateway
  app.use("/static", express.static("public", { maxAge: isDev ? 0 : "1h" }));

  // Compression (production only - Vite handles this in dev)
  if (!isDev) {
    app.use(compression());
  }

  let viteDevServer;
  let initModule;

  if (isDev) {
    // Development: Use Vite middleware for HMR
    const vite = await import("vite");
    viteDevServer = await vite.createServer({
      server: {
        middlewareMode: true,
        host: HOST,
        port: PORT,
        strictPort: true,
      },
    });
    // Vite middleware runs after static file middleware
    app.use(viteDevServer.middlewares);

    // Load init module through Vite (handles TypeScript + path aliases)
    initModule = await viteDevServer.ssrLoadModule("app/.server/init.ts");

    // React Router handler with Vite HMR
    app.all(
      "*",
      createRequestHandler({
        build: () =>
          viteDevServer.ssrLoadModule("virtual:react-router/server-build"),
      })
    );
  } else {
    // Production: Static files + compiled build
    app.use(express.static("build/client", { maxAge: "1h" }));

    const build = await import("./build/server/index.js");

    // Load init module from compiled build
    initModule = await import("./build/server/init.js").catch(() => {
      // Fallback: init might be bundled differently
      console.warn("Could not load init module directly, trying via build");
      return null;
    });

    app.all("*", createRequestHandler({ build }));
  }

  // Start server
  const server = app.listen(PORT, HOST, () => {
    console.log(
      `Server running at http://${HOST}:${PORT} (${isDev ? "development" : "production"})`
    );

    // Show network URLs with actual IP addresses
    const ifaces = networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        // Skip internal (i.e., 127.0.0.1) and non-IPv4 addresses
        if (!iface.internal && iface.family === 'IPv4') {
          addresses.push(`http://${iface.address}:${PORT}`);
        }
      }
    }

    if (addresses.length > 0) {
      console.log(`Network: ${addresses.join(', ')}`);
    }

    // Initialize application services (async)
    if (initModule?.initializeApp) {
      console.log("Initializing application services...");
      initModule.initializeApp()
        .then(() => {
          console.log("Application services initialized");
        })
        .catch((error) => {
          console.error("Failed to initialize application:", error);
        });
    } else {
      console.warn("Init module not available, services may not start");
    }
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down...`);

    // Shutdown application services
    if (initModule?.shutdownApp) {
      try {
        await initModule.shutdownApp();
      } catch (error) {
        console.error("Error during app shutdown:", error);
      }
    }

    // Close Vite dev server if running
    if (viteDevServer) {
      await viteDevServer.close();
    }

    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => process.exit(0), 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
