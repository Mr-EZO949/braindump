// Landing-only type. The app UI keeps Geist; the marketing pages get more
// character so they don't read as a generic AI/dev-tool template.
//   - Fraunces: an old-style display serif with real warmth (the scarlet payoff)
//   - Hanken Grotesk: a humanist sans for everything else on the page
import { Fraunces, Hanken_Grotesk } from "next/font/google";

export const displaySerif = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

export const heroSans = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-hero-sans",
  display: "swap",
});

// Convenience: both variable classNames, to spread on a wrapping element.
export const landingFontVars = `${displaySerif.variable} ${heroSans.variable}`;
