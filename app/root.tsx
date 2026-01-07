import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
} from "react-router";
import type { LinksFunction, MetaFunction } from "react-router";
import { Header } from "~/components/header";
import "./globals.css";

export const meta: MetaFunction = () => {
  return [
    { title: "MyLifeDB" },
    { name: "description", content: "Capture your thoughts effortlessly and transform them into structured, meaningful knowledge" },
    { name: "application-name", content: "MyLifeDB" },
    { name: "mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-status-bar-style", content: "default" },
    { name: "apple-mobile-web-app-title", content: "MyLifeDB" },
    { name: "format-detection", content: "telephone=no" },
    { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" },
    { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" },
    { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#000000" },
  ];
};

export const links: LinksFunction = () => {
  return [
    { rel: "icon", type: "image/png", sizes: "16x16", href: "/public/favicon-16x16.png" },
    { rel: "icon", type: "image/png", sizes: "32x32", href: "/public/favicon-32x32.png" },
    { rel: "apple-touch-icon", href: "/public/apple-touch-icon.png" },
    { rel: "manifest", href: "/public/manifest.webmanifest" },
  ];
};

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
      </head>
      <body className="antialiased grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] min-h-screen h-dvh w-full min-w-0 overflow-y-auto overflow-x-hidden">
        <ConditionalHeader />
        <main className="min-h-0 flex flex-col w-full min-w-0">
          {children}
        </main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function ConditionalHeader() {
  const location = useLocation();

  // Don't render Header on login page
  if (location.pathname === '/login') {
    return null;
  }

  return <Header />;
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">{message}</h1>
        <p className="text-muted-foreground">{details}</p>
        {stack && (
          <pre className="mt-4 p-4 bg-muted rounded-lg text-left text-xs overflow-auto max-w-2xl">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
