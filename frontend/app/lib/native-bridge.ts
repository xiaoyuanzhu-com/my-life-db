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
import type { Attachment } from "~/lib/agent-attachments";

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

  /** Ask the native shell to pop the current view (go back in NavigationStack). */
  goBack() {
    postNative("goBack");
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

/**
 * Present the native file picker on iOS, upload picked files to the backend
 * via the native shell, and resolve with the resulting Attachment records.
 *
 * iOS WKWebView's <input type="file"> click is gated by an in-gesture user
 * activation token. Radix UI's deferred DropdownMenu callback consumes it
 * before the click reaches WebKit, so the picker silently never opens. This
 * route sidesteps that path entirely — Swift presents UIDocumentPickerViewController,
 * uploads via the native API client, and returns Attachment records here.
 *
 * Returns an empty array on cancel or when not running in the native iOS shell.
 *
 * NOTE: Uses fetch('nativebridge://...') directly instead of postNative() so
 * we can read the JSON response body. postNative is fire-and-forget.
 */
export async function nativePickAndUploadFiles(
  storageId?: string | null,
): Promise<Attachment[]> {
  if (!isNativeApp() || nativePlatform() !== "ios") return [];
  try {
    const res = await fetch("nativebridge://message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pickAndUploadFiles",
        storageId: storageId ?? null,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { attachments?: Attachment[] };
    return Array.isArray(data?.attachments) ? data.attachments : [];
  } catch (e) {
    console.warn("[native-bridge] pickAndUploadFiles failed:", e);
    return [];
  }
}

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
      navigate(path, { replace: true });
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

    /**
     * Re-check authentication status (called by native after page load).
     * WKWebView cookies may not be available during the initial React mount,
     * so native signals the web frontend to re-verify after the page settles.
     */
    recheckAuth() {
      window.dispatchEvent(new Event("native-recheck-auth"));
    },
  };
}
