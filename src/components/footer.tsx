'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { siGithub, siDiscord } from 'simple-icons';
import { Settings } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';

export function Footer() {
  const currentPath = usePathname();

  // Hide footer on homepage, library, and file detail pages (show on other pages)
  if (currentPath === '/' || currentPath?.startsWith('/library') || currentPath?.startsWith('/file')) {
    return null;
  }

  return (
    <footer className="bg-card mt-auto">
      <div className="max-w-7xl mx-auto px-4 py-2">
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <Link
            href="https://xiaoyuanzhu.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          >
            <span>©</span>
            <span>小圆猪</span>
          </Link>

          <Link
            href="https://github.com/xiaoyuanzhu-com/my-life-db"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center hover:text-foreground transition-colors"
            title="GitHub Repository"
          >
            <svg className="h-3.5 w-3.5" role="img" viewBox="0 0 24 24" fill="currentColor">
              <path d={siGithub.path} />
            </svg>
          </Link>

          <Link
            href="https://discord.gg/Zqrr77UZ"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center hover:text-foreground transition-colors"
            title="Join Discord"
          >
            <svg className="h-3.5 w-3.5" role="img" viewBox="0 0 24 24" fill="currentColor">
              <path d={siDiscord.path} />
            </svg>
          </Link>

          <ThemeToggle />

          <Link
            href="/settings"
            className="flex items-center hover:text-foreground transition-colors"
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </footer>
  );
}
