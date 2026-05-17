import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { InstallBanner } from "@/components/pwa/install-banner";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0b0d",
};

export const metadata: Metadata = {
  title: "BrainDump — Stop organizing. Start thinking.",
  description: "Dump your raw thoughts into BrainDump. AI structures them into a living knowledge graph — tasks, goals, ideas, and connections you didn't know existed.",
  applicationName: "BrainDump",
  appleWebApp: {
    capable: true,
    title: "BrainDump",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
  formatDetection: { telephone: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The theme script below sets data-theme on <html> before hydration to
    // avoid a flash of the wrong palette. That intentionally makes the client
    // <html> differ from the server's, so suppress the (expected) hydration
    // attribute warning on this element only. Standard pattern for pre-paint
    // theme scripts (same approach next-themes uses).
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Legacy iOS standalone flag — Next emits the modern
            `mobile-web-app-capable`, but iOS < 16.4 still keys home-screen
            standalone launch off this one. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <script
          // Apply saved theme before first paint to avoid a flash of the
          // wrong palette. Defaults to dark if nothing stored.
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('braindump-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');}}catch(e){}",
          }}
        />
      </head>
      <body className={`${inter.variable} ${geistMono.variable} antialiased`}>
        <ServiceWorkerRegister />
        <InstallBanner />
        {children}
      </body>
    </html>
  );
}
