'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Settings } from 'lucide-react';
import { getGravatarUrl } from '@/lib/gravatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useEffect, useState } from 'react';

export function Header() {
  const pathname = usePathname();
  const [userEmail, setUserEmail] = useState('user@example.com');
  const [open, setOpen] = useState(false);

  // Load user email from settings
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data?.preferences?.userEmail) {
          setUserEmail(data.preferences.userEmail);
        }
      })
      .catch((error) => {
        console.error('Failed to load user email:', error);
      });
  }, []);

  const gravatarUrl = getGravatarUrl(userEmail, 128);

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
          <nav className="hidden md:flex gap-6 items-center">
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
            <div
              className="flex items-center"
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
            >
              <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    className="rounded-full hover:opacity-80 transition-opacity focus:outline-none cursor-pointer"
                    aria-label="User profile"
                  >
                    <Image
                      src={gravatarUrl}
                      alt="User avatar"
                      width={32}
                      height={32}
                      className="rounded-full pointer-events-none"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem asChild>
                    <Link href="/settings" className="flex items-center gap-2 cursor-pointer">
                      <Settings className="h-4 w-4" />
                      <span>Settings</span>
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
}
