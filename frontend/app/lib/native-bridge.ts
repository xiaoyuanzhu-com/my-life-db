/**
 * Native Bridge — communication layer between the web frontend and native iOS/macOS shell.
 *
 * When the web app runs inside WKWebView, the native shell injects:
 *   window.isNativeApp = true
 *   window.nativePlatform = 'ios' | 'macos' | 'visionos'
 *
 * This module provides:
 * 1. Detection: isNativeApp(), nativePlatform()
 * 2. Web → Native calls: nativeBridge.share(), .haptic(), .openExternal(), etc.
 * 3. Native → Web listeners: setupNativeListeners() exposes window.__nativeBridge
 */

import type { NavigateFunction } from "react-router";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Returns true when running inside the native iOS/macOS WKWebView shell. */
export function isNativeApp(): boolean {
  return typeof window !== "undefined" && (window as any).isNativeApp === true;
}

/** Returns the native platform, or 'web' when running in a browser. */
export function nativePlatform(): "ios" | "macos" | "visionos" | "web" {
  if (typeof window === "undefined") return "web";
  return (window as any).nativePlatform || "web";
}

// ---------------------------------------------------------------------------
// Web → Native calls
// ---------------------------------------------------------------------------

function postNative(action: string, data?: Record<string, unknown>) {
  try {
    (window as any).webkit?.messageHandlers?.native?.postMessage({
      action,
      ...data,
    });
  } catch (e) {
    console.warn(`[native-bridge] Failed to post "${action}":`, e);
  }
}

/** Web → Native bridge calls. No-ops when running in a regular browser. */
export const nativeBridge = {
  /** Present the native share sheet. */
  share(data: { title: string; url?: string; text?: string }) {
    postNative("share", data);
  },

  /** Trigger haptic feedback (iOS only). */
  haptic(style: "light" | "medium" | "heavy" = "medium") {
    postNative("haptic", { style });
  },

  /** Notify the native shell that the web-side navigated (for tab sync). */
  navigate(path: string) {
    postNative("navigate", { path });
  },

  /** Open a URL in the system browser (Safari). */
  openExternal(url: string) {
    postNative("openExternal", { url });
  },

  /** Copy text to the system clipboard. */
  copyToClipboard(text: string) {
    postNative("copyToClipboard", { text });
  },

  /** Forward a log message to native console. */
  log(message: string, level: "log" | "warn" | "error" = "log") {
    postNative("log", { message, level });
  },
};

// ---------------------------------------------------------------------------
// Native → Web listeners
// ---------------------------------------------------------------------------

/**
 * Set up the window.__nativeBridge object that the native shell calls via
 * `webView.evaluateJavaScript("window.__nativeBridge.navigateTo('/library')")`.
 *
 * Call this once on app mount when isNativeApp() is true.
 */
export function setupNativeListeners(navigate: NavigateFunction) {
  (window as any).__nativeBridge = {
    /**
     * Navigate to a route (called by native when the user taps a tab).
     * Uses React Router's navigate() so no page reload occurs.
     */
    navigateTo(path: string) {
      navigate(path);
    },

    /**
     * Set the color theme (called by native on system appearance change).
     * Directly toggles the .dark class on <html> — bypasses the useDarkMode() hook.
     */
    setTheme(theme: "light" | "dark") {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
    },

    /**
     * Trigger a data refresh (e.g., after pull-to-refresh in native).
     * Reloads the current page to re-fetch all data.
     */
    refresh() {
      window.location.reload();
    },
  };
}
