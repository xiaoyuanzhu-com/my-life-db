import { Link, useLocation } from 'react-router';
import { Database, Bot, User, Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '~/lib/utils';

const navItems = [
  { href: '/', labelKey: 'nav.data', icon: Database },
  { href: '/agent', labelKey: 'nav.agent', icon: Bot },
  { href: '/explore', labelKey: 'nav.explore', icon: Compass },
  { href: '/me', labelKey: 'nav.me', icon: User },
] as const;

export function BottomNav() {
  const location = useLocation();
  const pathname = location.pathname;
  const { t } = useTranslation('common');

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t md:hidden">
      <div className="pb-safe">
        <div className="flex items-center justify-around">
          {navItems.map((item) => {
            const isActive = item.href === '/'
              ? pathname === '/' || pathname.startsWith('/file/')
              : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 py-3 px-4 min-w-[64px] transition-colors',
                  'active:bg-accent/50',
                  isActive
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span className="text-xs font-medium">{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
