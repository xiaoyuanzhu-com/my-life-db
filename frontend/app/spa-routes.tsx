/**
 * SPA Routes Configuration
 *
 * Three-tab navigation: Data, Agent, Me
 */
import type { RouteObject } from "react-router";

// Layout component
import Root from "./root";

// Route components
import Data from "./routes/data";
import FileView from "./routes/file.$";
import Agent from "./routes/agent";
import Me from "./routes/me";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Root />,
    children: [
      {
        index: true,
        Component: Data,
      },
      {
        path: "file/*",
        Component: FileView,
      },
      {
        path: "agent",
        Component: Agent,
      },
      {
        path: "agent/:sessionId",
        Component: Agent,
      },
      {
        path: "me/*",
        Component: Me,
      },
    ],
  },
];
