import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

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
};

export const metadata: Metadata = {
  title: "BrainDump — Stop organizing. Start thinking.",
  description: "Dump your raw thoughts into BrainDump. AI structures them into a living knowledge graph — tasks, goals, ideas, and connections you didn't know existed.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
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
        {children}
      </body>
    </html>
  );
}
