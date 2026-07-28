/**
 * Global Authentication Context
 * Centrally manages authentication state and OAuth flow
 */

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '~/lib/api';

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (returnTo?: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuth = async () => {
    try {
      const response = await api.get('/api/system/settings');
      // In cloud mode the gateway gates every /api/system/* request before
      // it reaches this instance, so 401 is an authoritative "not signed in"
      // and 200 is an authoritative "signed in".
      //
      // Anything else (502/503 while the container is waking, a gateway
      // recover cycle) says nothing about the session — leave the last known
      // state alone rather than downgrading it.
      if (response.ok || response.status === 401) {
        setIsAuthenticated(response.ok);
      }
    } catch {
      // Transport failure, not a logout. This used to setIsAuthenticated(false),
      // which meant a single dropped request bounced an authenticated user to
      // the welcome screen — indistinguishable from a real sign-out.
    } finally {
      setIsLoading(false);
    }
  };

  // Check authentication status on mount
  useEffect(() => {
    checkAuth();
  }, []);

  // Listen for native bridge signal to re-check auth.
  // WKWebView cookies may not be ready during the initial mount,
  // so the native shell signals after the page finishes loading.
  useEffect(() => {
    const handler = () => { checkAuth(); };
    window.addEventListener('native-recheck-auth', handler);
    return () => window.removeEventListener('native-recheck-auth', handler);
  }, []);

  // Re-check auth when the tab becomes visible again, so a tab whose gateway
  // session expired while backgrounded doesn't sit on a stale view until a
  // hard reload.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') checkAuth();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Owner login lives on the cloud gateway, not on this backend — the
  // backend's /api/system/oauth/* routes were removed in 70a5cb3a. `/gw/*`
  // is explicitly never proxied to the instance, so this hits the gateway's
  // Authentik OIDC handoff. The native apps use the same URL.
  const login = (returnTo?: string) => {
    const url = new URL('/gw/auth/login', window.location.origin);
    if (returnTo) url.searchParams.set('next', returnTo);
    window.location.href = url.pathname + url.search;
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  // During SSR, context might not be available - return safe defaults
  if (context === undefined) {
    if (typeof window === 'undefined') {
      return {
        isAuthenticated: false,
        isLoading: true,
        login: () => {},
      };
    }
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}
