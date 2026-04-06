import { Link, useLocation } from 'react-router';
import { Database, Bot, User } from 'lucide-react';
import { cn } from '~/lib/utils';

const navItems = [
  {
    href: '/',
    label: 'Data',
    icon: Database,
  },
  {
    href: '/agent',
    label: 'Agent',
    icon: Bot,
  },
  {
    href: '/me',
    label: 'Me',
    icon: User,
  },
];

export function BottomNav() {
  const location = useLocation();
  const pathname = location.pathname;

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
                <span className="text-xs font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
