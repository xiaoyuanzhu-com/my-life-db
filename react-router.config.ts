import type { Config } from "@react-router/dev/config";

export default {
  // Use SSR for server-side rendering
  ssr: true,
  // App directory location
  appDirectory: "app",
  // Build directory
  buildDirectory: "build",
} satisfies Config;
