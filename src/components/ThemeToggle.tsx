'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, SunMoon } from 'lucide-react';

type Theme = 'auto' | 'light' | 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('auto');

  useEffect(() => {
    // Load theme from localStorage on mount
    const savedTheme = localStorage.getItem('theme') as Theme | null;
    if (savedTheme) {
      setTheme(savedTheme);
      applyTheme(savedTheme);
    }
  }, []);

  function applyTheme(newTheme: Theme) {
    const root = document.documentElement;

    if (newTheme === 'auto') {
      // Remove manual theme classes and let CSS media query handle it
      root.classList.remove('light', 'dark');
      localStorage.removeItem('theme');
    } else {
      // Apply manual theme
      root.classList.remove('light', 'dark');
      root.classList.add(newTheme);
      localStorage.setItem('theme', newTheme);
    }
  }

  function cycleTheme() {
    const themes: Theme[] = ['auto', 'light', 'dark'];
    const currentIndex = themes.indexOf(theme);
    const nextTheme = themes[(currentIndex + 1) % themes.length];

    setTheme(nextTheme);
    applyTheme(nextTheme);
  }

  function getIcon() {
    switch (theme) {
      case 'light':
        return <Sun className="h-3.5 w-3.5" />;
      case 'dark':
        return <Moon className="h-3.5 w-3.5" />;
      case 'auto':
      default:
        return <SunMoon className="h-3.5 w-3.5" />;
    }
  }

  return (
    <button
      onClick={cycleTheme}
      className="flex items-center hover:text-foreground transition-colors"
      title={`Theme: ${theme}`}
      aria-label={`Switch theme (current: ${theme})`}
    >
      {getIcon()}
    </button>
  );
}
