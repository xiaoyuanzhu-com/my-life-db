/**
 * Global Authentication Context
 * Centrally manages authentication state and OAuth flow
 */

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check authentication status on mount
  useEffect(() => {
    const checkAuth = async () => {
      const accessToken = localStorage.getItem('access_token');

      if (!accessToken) {
        setIsAuthenticated(false);
        setIsLoading(false);
        return;
      }

      try {
        // Verify token is valid by calling a protected endpoint
        const response = await fetch('/api/settings', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        setIsAuthenticated(response.ok);
      } catch {
        setIsAuthenticated(false);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
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
