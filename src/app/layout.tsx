import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { InstallBanner } from "@/components/pwa/install-banner";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { SITE_URL, absoluteUrl } from "@/lib/site";

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

const SITE_NAME = "BrainDump";
// Title mirrors the landing hero ("Dump it. Unfreeze your brain."); the
// description leads with the real payoff — AI hands back your next step — not
// "connections you didn't know existed" (old copy).
const TITLE_DEFAULT = "BrainDump — Dump it. Unfreeze your brain.";
const DESCRIPTION =
  "Dump your tangled thoughts into BrainDump and AI sorts the whole mess into clear priorities — then hands back the one thing to start now. A second brain for ADHD, overwhelm, and executive dysfunction.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE_DEFAULT,
    // Sub-pages set their own title; this appends the brand.
    template: "%s · BrainDump",
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  // Long-tail terms we can realistically win — NOT the generic "braindump"
  // head term. Keywords are a minor signal today, but they document intent.
  keywords: [
    "brain dump app",
    "AI second brain",
    "second brain for ADHD",
    "ADHD task manager",
    "executive dysfunction app",
    "AI thought organizer",
    "knowledge graph notes",
    "what should I work on next app",
    "anti-overwhelm productivity app",
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: TITLE_DEFAULT,
    description: DESCRIPTION,
    url: SITE_URL,
    images: [
      {
        // Replace with a purpose-built 1200×630 image at public/og.png for the
        // best link previews; the 512 icon is a working fallback.
        url: absoluteUrl("/icons/icon-512.png"),
        width: 512,
        height: 512,
        alt: "BrainDump — AI second brain",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE_DEFAULT,
    description: DESCRIPTION,
    images: [absoluteUrl("/icons/icon-512.png")],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
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

// JSON-LD structured data — tells search engines this is a SoftwareApplication,
// which unlocks rich results and helps disambiguate "BrainDump the app" from
// the generic term. Rendered as a raw <script> in <head>.
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "ProductivityApplication",
  operatingSystem: "Web, iOS, Android (PWA)",
  description: DESCRIPTION,
  url: SITE_URL,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
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
        {/* Structured data (SoftwareApplication) for rich results + entity
            disambiguation. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
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
