'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';

export function Header() {
  const pathname = usePathname();

  const navLinks = [
    { href: '/', label: 'Home' },
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
        </div>
      </div>
    </header>
  );
}
