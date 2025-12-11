/**
 * Production Server Entry Point
 *
 * In development, use `npm run dev` (react-router dev) which handles everything.
 * This file runs in production only and initializes services before starting Express.
 */

import compression from "compression";
import express from "express";
import { createRequestHandler } from "@react-router/express";

const PORT = process.env.PORT || 3000;

async function main() {
  // Import the React Router server build
  const build = await import("./build/server/index.js");

  // Create Express app
  const app = express();

  // Trust proxy
  app.set("trust proxy", true);

  // Compression
  app.use(compression());

  // Static files from client build
  app.use(express.static("build/client", { maxAge: "1h" }));

  // React Router handler
  const handler = createRequestHandler({ build });
  app.all("*", handler);

  // Start server
  const server = app.listen(PORT, async () => {
    console.log(`Server running at http://localhost:${PORT}`);

    // Trigger initialization by calling the init endpoint
    // This ensures all services start before accepting real traffic
    try {
      console.log("Initializing application...");
      const response = await fetch(`http://localhost:${PORT}/api/init`);
      const result = await response.json();
      console.log("Application initialized:", result.status);
    } catch (error) {
      console.error("Failed to initialize application:", error);
      // Don't exit - services may still initialize on first request
    }
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down...`);

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
