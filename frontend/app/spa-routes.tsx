/**
 * SPA Routes Configuration
 *
 * This file defines routes for the SPA build (Go server).
 * It mirrors the routes.ts configuration but uses react-router's createBrowserRouter format.
 */
import type { RouteObject } from "react-router";

// Layout component
import Root from "./root";

// Direct imports (no lazy loading) - bundle all routes in main
import Home from "./routes/home";
import Inbox from "./routes/inbox";
import InboxDetail from "./routes/inbox.$id";
import Library from "./routes/library";
import LibraryBrowse from "./routes/library.browse";
import FileView from "./routes/file.$";
import People from "./routes/people";
import PeopleDetail from "./routes/people.$id";
import Settings from "./routes/settings";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Root />,
    children: [
      {
        index: true,
        Component: Home,
      },
      {
        path: "inbox",
        Component: Inbox,
      },
      {
        path: "inbox/:id",
        Component: InboxDetail,
      },
      {
        path: "library",
        Component: Library,
      },
      {
        path: "library/browse",
        Component: LibraryBrowse,
      },
      {
        path: "file/*",
        Component: FileView,
      },
      {
        path: "people",
        Component: People,
      },
      {
        path: "people/:id",
        Component: PeopleDetail,
      },
      {
        path: "settings/*",
        Component: Settings,
      },
    ],
  },
];
