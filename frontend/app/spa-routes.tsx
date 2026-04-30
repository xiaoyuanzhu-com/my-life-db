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
import DataApps from "./routes/data.apps";
import FileView from "./routes/file.$";
import Explore from "./routes/explore";
import Agent from "./routes/agent";
import Me from "./routes/me";
import ConnectAuthorize from "./routes/connect.authorize";

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
        path: "data/apps",
        Component: DataApps,
      },
      {
        path: "file/*",
        Component: FileView,
      },
      {
        path: "explore",
        Component: Explore,
      },
      {
        path: "explore/:postId",
        Component: Explore,
      },
      {
        path: "agent",
        Component: Agent,
      },
      {
        path: "agent/auto",
        Component: Agent,
      },
      {
        path: "agent/auto/:sessionId",
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
      {
        path: "connect/authorize",
        Component: ConnectAuthorize,
      },
    ],
  },
];
