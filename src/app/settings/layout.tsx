import { SettingsProvider } from './_context/settings-context';
import { ReactNode } from 'react';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}
