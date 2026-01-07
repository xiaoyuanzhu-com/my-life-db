import { Link, useLocation } from 'react-router';
import { Settings, Home, Library, CircleUserRound } from 'lucide-react';
import { getGravatarUrlSync } from '~/lib/gravatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet';
import { useEffect, useState } from 'react';

export function Header() {
  const location = useLocation();
  const pathname = location.pathname;
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [desktopDropdownOpen, setDesktopDropdownOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Load user email from settings
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => {
        if (res.status === 401) {
          // Auth required but not authenticated - redirect to login
          window.location.href = '/login';
          return;
        }
        return res.json();
      })
      .then((data) => {
        if (data?.preferences?.userEmail) {
          setUserEmail(data.preferences.userEmail);
        }
      })
      .catch((error) => {
        console.error('Failed to load user email:', error);
      });
  }, []);

  const gravatarUrl = userEmail ? getGravatarUrlSync(userEmail, 128) : null;

  const navLinks = [
    { href: '/', label: 'Home', icon: Home },
    { href: '/library', label: 'Library', icon: Library },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <header className="bg-card border-b sticky top-0 z-10">
      <div className="w-full px-4 py-2 md:px-[10%]">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <img
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
            {navLinks.slice(0, 2).map((link) => {
              const isActive = pathname === link.href;
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
                  {link.label}
                </Link>
              );
            })}
            <div
              className="flex items-center"
              onMouseEnter={() => setDesktopDropdownOpen(true)}
              onMouseLeave={() => setDesktopDropdownOpen(false)}
            >
              <DropdownMenu open={desktopDropdownOpen} onOpenChange={setDesktopDropdownOpen} modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    className="rounded-full hover:opacity-80 transition-opacity focus:outline-none cursor-pointer"
                    aria-label="User profile"
                  >
                    {gravatarUrl ? (
                      <img
                        src={gravatarUrl}
                        alt="User avatar"
                        width={32}
                        height={32}
                        className="rounded-full pointer-events-none"
                      />
                    ) : (
                      <CircleUserRound className="h-8 w-8 text-muted-foreground" />
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem asChild>
                    <Link to="/settings" className="flex items-center gap-2 cursor-pointer">
                      <Settings className="h-4 w-4" />
                      <span>Settings</span>
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </nav>

          {/* Mobile menu - visible only on mobile */}
          <div className="md:hidden">
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <button
                  className="rounded-full hover:opacity-80 transition-opacity focus:outline-none cursor-pointer"
                  aria-label="Open menu"
                >
                  {gravatarUrl ? (
                    <img
                      src={gravatarUrl}
                      alt="User avatar"
                      width={32}
                      height={32}
                      className="rounded-full pointer-events-none"
                    />
                  ) : (
                    <CircleUserRound className="h-8 w-8 text-muted-foreground" />
                  )}
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[280px]">
                <SheetHeader>
                  <SheetTitle>Menu</SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-1 mt-6">
                  {navLinks.map((link) => {
                    const isActive = pathname === link.href;
                    const Icon = link.icon;
                    return (
                      <Link
                        key={link.href}
                        to={link.href}
                        onClick={() => setMobileMenuOpen(false)}
                        className={`flex items-center gap-3 px-3 py-3 rounded-md transition-colors ${
                          isActive
                            ? 'bg-accent text-primary font-medium'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                        }`}
                      >
                        <Icon className="h-5 w-5" />
                        <span>{link.label}</span>
                      </Link>
                    );
                  })}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  );
}
