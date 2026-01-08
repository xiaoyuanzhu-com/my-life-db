/**
 * SPA Routes Configuration
 *
 * This file defines routes for the SPA build (Go server).
 * It mirrors the routes.ts configuration but uses react-router's createBrowserRouter format.
 */
import { lazy, Suspense } from "react";
import type { RouteObject } from "react-router";

// Layout component
import Root from "./root";

// Lazy load route components for code splitting
const Home = lazy(() => import("./routes/home"));
const Inbox = lazy(() => import("./routes/inbox"));
const InboxDetail = lazy(() => import("./routes/inbox.$id"));
const Library = lazy(() => import("./routes/library"));
const LibraryBrowse = lazy(() => import("./routes/library.browse"));
const FileView = lazy(() => import("./routes/file.$"));
const People = lazy(() => import("./routes/people"));
const PeopleDetail = lazy(() => import("./routes/people.$id"));
const Settings = lazy(() => import("./routes/settings"));

// Loading fallback
function Loading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}

// Wrap component with Suspense
function withSuspense(Component: React.ComponentType) {
  return function SuspenseWrapper() {
    return (
      <Suspense fallback={<Loading />}>
        <Component />
      </Suspense>
    );
  };
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Root />,
    children: [
      {
        index: true,
        Component: withSuspense(Home),
      },
      {
        path: "inbox",
        Component: withSuspense(Inbox),
      },
      {
        path: "inbox/:id",
        Component: withSuspense(InboxDetail),
      },
      {
        path: "library",
        Component: withSuspense(Library),
      },
      {
        path: "library/browse",
        Component: withSuspense(LibraryBrowse),
      },
      {
        path: "file/*",
        Component: withSuspense(FileView),
      },
      {
        path: "people",
        Component: withSuspense(People),
      },
      {
        path: "people/:id",
        Component: withSuspense(PeopleDetail),
      },
      {
        path: "settings/*",
        Component: withSuspense(Settings),
      },
    ],
  },
];
