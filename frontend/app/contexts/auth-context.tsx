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
      setIsAuthenticated(response.ok);
    } catch {
      setIsAuthenticated(false);
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

  // Re-check auth when the tab becomes visible again. Without this, a
  // long-lived tab whose access token expired stays stuck on the welcome
  // screen until a hard reload — even though /api/system/oauth/refresh
  // would succeed. The fetch goes through fetchWithRefresh, so a 401
  // triggers a refresh-and-retry transparently.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') checkAuth();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const login = (returnTo?: string) => {
    const url = new URL('/api/system/oauth/authorize', window.location.origin);
    if (returnTo) url.searchParams.set('return_to', returnTo);
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
