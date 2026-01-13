/**
 * SPA Entry Point for Go Server
 *
 * This entry point renders the app as a client-side SPA without SSR.
 * Used when building for the Go server.
 */
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Import routes configuration
import { routes } from "./spa-routes";

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
  const root = createRoot(container);
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
