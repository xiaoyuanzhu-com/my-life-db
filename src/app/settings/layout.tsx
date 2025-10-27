import { SettingsProvider } from './_context/SettingsContext';
import { ReactNode } from 'react';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}
