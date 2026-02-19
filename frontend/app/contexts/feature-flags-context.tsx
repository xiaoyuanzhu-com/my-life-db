/**
 * Feature Flags Context
 *
 * Reads feature flags from window.__featureFlags (injected by the native shell
 * before React mounts) and provides them to the component tree.
 *
 * When running in a regular browser, all flags default to true (all features enabled).
 * The native app can selectively disable features per-WebView by setting flags to false.
 */

import { createContext, useContext, type ReactNode } from 'react'

export interface FeatureFlags {
  /** Show the sessions sidebar (desktop and mobile variants). Default: true */
  sessionSidebar: boolean
  /** Show "New session" buttons. Default: true */
  sessionCreateNew: boolean
}

const defaultFlags: FeatureFlags = {
  sessionSidebar: true,
  sessionCreateNew: true,
}

/** Read flags from window.__featureFlags, falling back to defaults. */
function resolveFlags(): FeatureFlags {
  if (typeof window === 'undefined') return defaultFlags

  const raw = (window as any).__featureFlags as
    | Partial<Record<keyof FeatureFlags, boolean>>
    | undefined
  if (!raw) return defaultFlags

  return {
    sessionSidebar: raw.sessionSidebar ?? defaultFlags.sessionSidebar,
    sessionCreateNew: raw.sessionCreateNew ?? defaultFlags.sessionCreateNew,
  }
}

const FeatureFlagsContext = createContext<FeatureFlags>(defaultFlags)

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  // Read once — flags are injected before React mounts and never change.
  const flags = resolveFlags()

  return (
    <FeatureFlagsContext.Provider value={flags}>
      {children}
    </FeatureFlagsContext.Provider>
  )
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext)
}
