#!/usr/bin/env node

/**
 * Modular script to run various services
 * Usage: ./run.js <service> [--watch]
 *
 * Zero dependencies - uses Node.js built-ins only
 * Requires globally installed: smee-client (npm install -g smee-client)
 */

import { spawn, execSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = __dirname;

// Configuration
const SMEE_URL = "https://smee.io/HgO0qrM4nNJLQv0";
const WEBHOOK_PORT = 9999;
const WATCH_INTERVAL_MS = 2000;

// Default data directories (can be overridden by env vars)
const USER_DATA_DIR = process.env.USER_DATA_DIR || resolve(PROJECT_ROOT, "data");
const APP_DATA_DIR = process.env.APP_DATA_DIR || resolve(PROJECT_ROOT, ".my-life-db");

// ANSI color codes
const colors = {
  red: (s) => `\x1b[0;31m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[0;36m${s}\x1b[0m`,
};

const log = {
  info: (msg) => console.log(`${colors.green("[INFO]")} ${msg}`),
  error: (msg) => console.error(`${colors.red("[ERROR]")} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow("[WARN]")} ${msg}`),
  debug: (msg) => console.log(`${colors.cyan("[DEBUG]")} ${msg}`),
};

/**
 * Load .env file if it exists
 */
function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;

  log.info("Loading environment variables from .env");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Get current git HEAD
 */
function getGitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Get changed files between two commits
 */
function getChangedFiles(fromCommit, toCommit) {
  try {
    const output = execSync(`git diff --name-only ${fromCommit}..${toCommit}`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f);
  } catch {
    return [];
  }
}

/**
 * Check if any changed files match the given prefix
 */
function hasChangesIn(changedFiles, prefix) {
  return changedFiles.some((f) => f.startsWith(prefix));
}

/**
 * Spawn a process with inherited stdio
 */
function spawnProcess(command, args, options = {}) {
  const proc = spawn(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    ...options,
  });
  return proc;
}

/**
 * Wait for a process to exit
 */
function waitForExit(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.on("exit", resolve);
  });
}

/**
 * Run a service with optional watch mode
 */
async function runWithWatch(serviceName, startFn, watchPrefix, watch) {
  if (!watch) {
    const proc = await startFn();
    if (proc) {
      // Handle graceful shutdown for non-watch mode
      const shutdown = async () => {
        log.info("Shutting down...");
        proc.kill("SIGTERM");
        await waitForExit(proc);
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Wait for process to exit naturally
      await waitForExit(proc);
    }
    return;
  }

  log.info(`Starting ${serviceName} in watch mode (monitoring ${watchPrefix}*)`);

  let currentHead = getGitHead();
  let currentProcess = null;

  const startService = async () => {
    currentProcess = await startFn();
    return currentProcess;
  };

  const restartService = async () => {
    if (currentProcess) {
      log.info(`Restarting ${serviceName}...`);
      currentProcess.kill("SIGTERM");
      await waitForExit(currentProcess);
    }
    await startService();
  };

  // Start initial process
  await startService();

  // Poll for git changes
  setInterval(async () => {
    const newHead = getGitHead();
    if (newHead && newHead !== currentHead) {
      const changedFiles = getChangedFiles(currentHead, newHead);
      log.debug(`Git HEAD changed: ${currentHead.slice(0, 7)} -> ${newHead.slice(0, 7)}`);
      log.debug(`Changed files: ${changedFiles.join(", ")}`);

      if (hasChangesIn(changedFiles, watchPrefix)) {
        log.info(`Changes detected in ${watchPrefix}*`);
        currentHead = newHead;
        await restartService();
      } else {
        log.debug(`No changes in ${watchPrefix}*, skipping restart`);
        currentHead = newHead;
      }
    }
  }, WATCH_INTERVAL_MS);

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    if (currentProcess) {
      currentProcess.kill("SIGTERM");
      await waitForExit(currentProcess);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ============================================================================
// Service Functions
// ============================================================================

async function runFrontend() {
  log.info("Starting frontend development server...");
  return spawnProcess("npm", ["run", "dev"], {
    cwd: resolve(PROJECT_ROOT, "frontend"),
  });
}

async function runBackend() {
  log.info("Building and starting backend server...");
  loadEnv();

  // Build backend
  log.info("Building backend...");
  const buildResult = spawnSync("go", ["build", "."], {
    cwd: resolve(PROJECT_ROOT, "backend"),
    stdio: "inherit",
  });

  if (buildResult.status !== 0) {
    log.error("Failed to build backend");
    process.exit(1);
  }

  // Start backend
  log.info("Starting backend server...");
  return spawnProcess("./backend/my-life-db", [], {
    cwd: PROJECT_ROOT,
  });
}

async function runMeilisearch() {
  log.info("Starting Meilisearch with Docker...");

  const MEILI_VERSION = "v1.27";
  const MEILI_PORT = "7700";
  const MEILI_DATA_DIR = resolve(APP_DATA_DIR, "meili");

  // Create data directory if needed
  execSync(`mkdir -p "${MEILI_DATA_DIR}"`);

  log.info(`Data will be persisted to: ${MEILI_DATA_DIR}`);
  log.info(`Meilisearch will be available at: http://localhost:${MEILI_PORT}`);

  // Check if container is already running
  try {
    const running = execSync("docker ps --format '{{.Names}}'", { encoding: "utf-8" });
    if (running.includes("meilisearch")) {
      log.warn("Meilisearch container is already running");
      log.info("To stop it, run: docker stop meilisearch");
      return null;
    }
  } catch {
    // Ignore
  }

  // Pull image
  spawnSync("docker", ["pull", `getmeili/meilisearch:${MEILI_VERSION}`], { stdio: "inherit" });

  // Run container
  return spawnProcess("docker", [
    "run",
    "--rm",
    "--name",
    "meilisearch",
    "-p",
    `${MEILI_PORT}:7700`,
    "-e",
    "MEILI_ENV=development",
    "-v",
    `${MEILI_DATA_DIR}:/meili_data`,
    `getmeili/meilisearch:${MEILI_VERSION}`,
  ]);
}

async function runQdrant() {
  log.info("Starting Qdrant with Docker...");

  const QDRANT_VERSION = "v1.16";
  const QDRANT_PORT = "6333";
  const QDRANT_DATA_DIR = resolve(APP_DATA_DIR, "qdrant");

  // Create data directory if needed
  execSync(`mkdir -p "${QDRANT_DATA_DIR}"`);

  log.info(`Data will be persisted to: ${QDRANT_DATA_DIR}`);
  log.info(`Qdrant HTTP API will be available at: http://localhost:${QDRANT_PORT}`);
  log.info(`Qdrant gRPC API will be available at: http://localhost:6334`);

  // Check if container is already running
  try {
    const running = execSync("docker ps --format '{{.Names}}'", { encoding: "utf-8" });
    if (running.includes("qdrant")) {
      log.warn("Qdrant container is already running");
      log.info("To stop it, run: docker stop qdrant");
      return null;
    }
  } catch {
    // Ignore
  }

  // Pull image
  spawnSync("docker", ["pull", `qdrant/qdrant:${QDRANT_VERSION}`], { stdio: "inherit" });

  // Run container
  return spawnProcess("docker", [
    "run",
    "--rm",
    "--name",
    "qdrant",
    "-p",
    `${QDRANT_PORT}:6333`,
    "-p",
    "6334:6334",
    "-v",
    `${QDRANT_DATA_DIR}:/qdrant/storage`,
    `qdrant/qdrant:${QDRANT_VERSION}`,
  ]);
}

async function runGithub() {
  log.info("Starting GitHub webhook listener...");
  log.info(`Smee URL: ${SMEE_URL}`);
  log.info(`Webhook port: ${WEBHOOK_PORT}`);

  // Start webhook HTTP server
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("OK");
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);

        // Handle GitHub push event
        if (payload.ref && payload.commits) {
          const branch = payload.ref.replace("refs/heads/", "");
          log.info(`Received push to ${branch} (${payload.commits.length} commits)`);

          // Only pull for main branch
          if (branch === "main" || branch === "master") {
            log.info("Pulling latest changes...");

            const beforeHead = getGitHead();

            try {
              execSync("git fetch origin", { cwd: PROJECT_ROOT, stdio: "inherit" });
              execSync(`git reset --hard origin/${branch}`, { cwd: PROJECT_ROOT, stdio: "inherit" });

              const afterHead = getGitHead();
              if (beforeHead !== afterHead) {
                const changedFiles = getChangedFiles(beforeHead, afterHead);
                log.info(`Updated: ${beforeHead?.slice(0, 7)} -> ${afterHead?.slice(0, 7)}`);
                log.info(`Changed files:\n  ${changedFiles.join("\n  ")}`);
              }
            } catch (e) {
              log.error(`Git pull failed: ${e.message}`);
            }
          } else {
            log.debug(`Ignoring push to non-main branch: ${branch}`);
          }
        }
      } catch (e) {
        log.debug(`Failed to parse webhook payload: ${e.message}`);
      }

      res.writeHead(200);
      res.end("OK");
    });
  });

  server.listen(WEBHOOK_PORT, () => {
    log.info(`Webhook server listening on port ${WEBHOOK_PORT}`);
  });

  // Start smee client
  log.info("Starting smee client...");
  const smee = spawnProcess("smee", ["-u", SMEE_URL, "-t", `http://localhost:${WEBHOOK_PORT}`]);

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    smee.kill("SIGTERM");
    await waitForExit(smee);
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep running until smee exits
  await waitForExit(smee);
}

// ============================================================================
// Main
// ============================================================================

function printUsage() {
  console.log(`
Usage: ./run.js <service> [--watch]

Available services:
  frontend    Start frontend development server
  backend     Build and start backend server
  meili       Start Meilisearch search engine (Docker)
  qdrant      Start Qdrant vector database (Docker)
  github      Start GitHub webhook listener (smee.io)

Options:
  --watch     Auto-restart service when git changes detected
              (only for frontend and backend)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const service = args[0];
  const watch = args.includes("--watch");

  if (!service) {
    log.error("No service specified");
    printUsage();
    process.exit(1);
  }

  switch (service) {
    case "frontend":
      await runWithWatch("frontend", runFrontend, "frontend/", watch);
      break;

    case "backend":
      await runWithWatch("backend", runBackend, "backend/", watch);
      break;

    case "meili":
    case "meilisearch": {
      if (watch) log.warn("--watch not supported for meili, ignoring");
      const proc = await runMeilisearch();
      if (proc) {
        const shutdown = async () => {
          log.info("Shutting down...");
          proc.kill("SIGTERM");
          await waitForExit(proc);
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        await waitForExit(proc);
      }
      break;
    }

    case "qdrant": {
      if (watch) log.warn("--watch not supported for qdrant, ignoring");
      const proc = await runQdrant();
      if (proc) {
        const shutdown = async () => {
          log.info("Shutting down...");
          proc.kill("SIGTERM");
          await waitForExit(proc);
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        await waitForExit(proc);
      }
      break;
    }

    case "github":
      if (watch) log.warn("--watch not supported for github, ignoring");
      await runGithub();
      break;

    default:
      log.error(`Unknown service: ${service}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
