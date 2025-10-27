'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SettingsNav() {
  const pathname = usePathname();

  const tabs = [
    { label: 'General', path: '/settings' },
    { label: 'Processing', path: '/settings/processing' },
    { label: 'Vendors', path: '/settings/vendors' },
  ];

  return (
    <div className="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
      {tabs.map((tab) => (
        <Link
          key={tab.path}
          href={tab.path}
          className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
            pathname === tab.path
              ? 'bg-background text-foreground shadow-sm'
              : 'hover:bg-background/50'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
