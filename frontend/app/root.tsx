import { useEffect } from "react";
import { Outlet, ScrollRestoration, isRouteErrorResponse, useLocation, useNavigate } from "react-router";
import { Header } from "~/components/header";
import { AuthProvider } from "~/contexts/auth-context";
import { Toaster } from "~/components/ui/sonner";
import { isNativeApp, setupNativeListeners } from "~/lib/native-bridge";
import "./globals.css";

function useDarkMode() {
  useEffect(() => {
    // In native app mode, theme is controlled by the native shell via
    // window.__nativeBridge.setTheme() — skip the media query listener.
    if (isNativeApp()) return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    const update = () => {
      const isDark = mq.matches;
      document.documentElement.classList.toggle('dark', isDark);
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    };

    update();
    mq.addEventListener('change', update);

    // Re-apply on visibility change (fixes bfcache issues on mobile)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        update();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      mq.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}

function ConditionalHeader() {
  const location = useLocation();
  const isClaudePage = location.pathname.startsWith('/claude');

  // Hide header on mobile for Claude page, always show on desktop
  return (
    <div className={isClaudePage ? 'hidden md:block' : ''}>
      <Header />
    </div>
  );
}

export default function Root() {
  useDarkMode();
  useNativeBridge();

  const native = isNativeApp();

  return (
    <div className={`antialiased grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] min-h-screen h-dvh w-full min-w-0 overflow-y-auto overflow-x-hidden${native ? ' native-app' : ''}`}>
      <AuthProvider>
        {/* Hide header in native app — the native SwiftUI shell provides navigation chrome */}
        {!native && <ConditionalHeader />}
        <main className={`min-h-0 h-full flex flex-col w-full min-w-0${native ? '' : ' row-start-2'}`}>
          <Outlet />
        </main>
      </AuthProvider>
      <ScrollRestoration />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

/** Set up the Native → Web bridge listeners when running inside WKWebView. */
function useNativeBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isNativeApp()) return;
    setupNativeListeners(navigate);
  }, [navigate]);
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
