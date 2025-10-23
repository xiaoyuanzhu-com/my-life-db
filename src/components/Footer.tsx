import Link from 'next/link';
import { siGithub, siDiscord } from 'simple-icons';

export function Footer() {
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
        </div>
      </div>
    </footer>
  );
}
