/**
 * Global Authentication Context
 * Centrally manages authentication state and OAuth flow
 */

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '~/lib/api';

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuth = async () => {
    try {
      const response = await api.get('/api/settings');
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

  const login = () => {
    window.location.href = '/api/oauth/authorize';
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
