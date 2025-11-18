import type { Metadata, Viewport } from "next";
import { Header } from "@/components/header";
import { BottomNav } from "@/components/bottom-nav";
import { Footer } from "@/components/footer";
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
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased flex flex-col min-h-screen h-dvh overflow-y-auto`}
      >
        <Header />
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden pb-16 md:pb-0">
          {children}
        </main>
        <Footer />
        <BottomNav />
      </body>
    </html>
  );
}
