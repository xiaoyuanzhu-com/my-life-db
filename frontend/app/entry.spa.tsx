/**
 * SPA Entry Point for Go Server
 *
 * This entry point renders the app as a client-side SPA without SSR.
 * Used when building for the Go server.
 */
import '~/lib/i18n/config';
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Import routes configuration
import { routes } from "./spa-routes";
import { captureComponentStack } from "./lib/error-report";

// Import global styles
import "./globals.css";

// Create query client for data fetching
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
    },
  },
});

// Create browser router
const router = createBrowserRouter(routes);

// Render the app
const container = document.getElementById("root");
if (container) {
  // React only hands out `componentStack` through these callbacks — the
  // error boundary itself receives the bare error. Stash it so
  // AppErrorScreen can show which component tree the crash came from
  // (see lib/error-report.ts).
  const root = createRoot(container, {
    onCaughtError: (error, errorInfo) => {
      captureComponentStack(error, errorInfo?.componentStack);
    },
    onUncaughtError: (error, errorInfo) => {
      captureComponentStack(error, errorInfo?.componentStack);
    },
  });
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
