import { Link, useLocation } from 'react-router';
import github from 'thesvg/github';
import discord from 'thesvg/discord';
import { Settings } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';

export function Footer() {
  const location = useLocation();
  const currentPath = location.pathname;

  // Hide footer on homepage, library, and file detail pages (show on other pages)
  if (currentPath === '/' || currentPath?.startsWith('/library') || currentPath?.startsWith('/file')) {
    return null;
  }

  return (
    <footer className="bg-card mt-auto">
      <div className="max-w-7xl mx-auto px-4 py-2">
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <a
            href="https://xiaoyuanzhu.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          >
            <span>©</span>
            <span>小圆猪</span>
          </a>

          <a
            href="https://github.com/xiaoyuanzhu-com/my-life-db"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center hover:text-foreground transition-colors"
            title="GitHub Repository"
          >
            <span
              className="block h-3.5 w-3.5 [&_svg]:h-full [&_svg]:w-full [&_svg]:fill-current"
              dangerouslySetInnerHTML={{ __html: github.variants.mono }}
            />
          </a>

          <a
            href="https://discord.gg/Zqrr77UZ"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center hover:text-foreground transition-colors"
            title="Join Discord"
          >
            <span
              className="block h-3.5 w-3.5 [&_svg]:h-full [&_svg]:w-full [&_svg]:fill-current"
              dangerouslySetInnerHTML={{ __html: discord.variants.mono }}
            />
          </a>

          <ThemeToggle />

          <Link
            to="/settings"
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
