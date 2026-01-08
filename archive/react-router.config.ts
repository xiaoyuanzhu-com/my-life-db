import type { Config } from "@react-router/dev/config";

export default {
  // Keep SSR enabled for API routes support
  ssr: true,
  // App directory location
  appDirectory: "app",
  // Build directory
  buildDirectory: "build",
} satisfies Config;
