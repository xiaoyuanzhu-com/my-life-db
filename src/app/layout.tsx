import type { Metadata, Viewport } from "next";
import { Header } from "@/components/header";
import "./globals.css";

// Temporarily using system fonts due to build environment network restrictions
// TODO: Re-enable Google Fonts (Geist, Geist_Mono) when building in environment with network access
const geistSans = {
  variable: "--font-geist-sans",
};

const geistMono = {
  variable: "--font-geist-mono",
};

export const metadata: Metadata = {
  title: "MyLifeDB",
  description: "Capture your thoughts effortlessly and transform them into structured, meaningful knowledge",
  applicationName: "MyLifeDB",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "MyLifeDB",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
    other: [
      { rel: 'android-chrome-192x192', url: '/android-chrome-192x192.png' },
      { rel: 'android-chrome-512x512', url: '/android-chrome-512x512.png' },
    ],
  },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' }
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] min-h-screen h-dvh w-full min-w-0 overflow-y-auto overflow-x-hidden`}
      >
        <Header />
        <main className="min-h-0 flex flex-col w-full min-w-0">
          {children}
        </main>
      </body>
    </html>
  );
}
