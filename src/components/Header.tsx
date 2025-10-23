'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Settings } from 'lucide-react';

export function Header() {
  const pathname = usePathname();

  const navLinks = [
    { href: '/', label: 'Home' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/library', label: 'Library' },
  ];

  return (
    <header className="bg-card border-b sticky top-0 z-10">
      <div className="px-[10%] py-2">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/my-life-db-logo.png"
              alt="MyLifeDB Logo"
              width={48}
              height={48}
              className="rounded-md"
            />
            <span className="text-xl font-bold text-foreground">MyLifeDB</span>
          </Link>

          <div className="flex items-center gap-4">
            {/* Desktop navigation - hidden on mobile */}
            <nav className="hidden md:flex gap-6">
              {navLinks.map((link) => {
                const isActive = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`text-sm font-medium transition-colors ${
                      isActive
                        ? 'text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>

            {/* Settings icon */}
            <Link
              href="/settings"
              className={`p-2 rounded-md transition-colors ${
                pathname === '/settings'
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title="Settings"
            >
              <Settings className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
