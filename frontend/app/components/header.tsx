import { Link, useLocation } from 'react-router';
import { Database, Terminal, User, Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '~/contexts/auth-context';

const navLinks = [
  { href: '/', labelKey: 'nav.data', icon: Database },
  { href: '/agent', labelKey: 'nav.agent', icon: Terminal },
  { href: '/explore', labelKey: 'nav.explore', icon: Compass },
  { href: '/me', labelKey: 'nav.me', icon: User },
] as const;

export function Header() {
  const location = useLocation();
  const pathname = location.pathname;
  const { isAuthenticated, login } = useAuth();
  const { t } = useTranslation('common');

  return (
    <header className="bg-card border-b sticky top-0 z-10">
      <div className="w-full px-4 py-2 md:px-[10%]">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <img
              src="/static/my-life-db-logo-144.png"
              alt="MyLifeDB Logo"
              width={48}
              height={48}
              className="rounded-md"
              fetchPriority="high"
            />
            <span className="text-xl font-bold text-foreground">MyLifeDB</span>
          </Link>

          {/* Desktop navigation - hidden on mobile */}
          <nav className="hidden md:flex gap-6 items-center">
            {isAuthenticated && navLinks.map((link) => {
              const isActive = link.href === '/'
                ? pathname === '/' || pathname.startsWith('/file/') || pathname.startsWith('/data/')
                : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  to={link.href}
                  className={`text-sm font-medium transition-colors ${
                    isActive
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(link.labelKey)}
                </Link>
              );
            })}
            {!isAuthenticated && (
              <button
                onClick={login}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
              >
                {t('auth.signIn')}
              </button>
            )}
          </nav>

          {/* Mobile: Sign In button only for unauthenticated users; BottomNav handles nav */}
          <div className="md:hidden">
            {!isAuthenticated && (
              <button
                onClick={login}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
              >
                {t('auth.signIn')}
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
