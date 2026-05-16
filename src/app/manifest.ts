import type { MetadataRoute } from "next";

// Next automatically serves this at /manifest.webmanifest and injects the
// <link rel="manifest"> tag, making the app installable to the home screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BrainDump — Stop planning. Start working.",
    short_name: "BrainDump",
    description:
      "Dump your thoughts as messy text. The AI turns it into a graph of connected priorities and tells you what to work on next.",
    // Open straight into the workspace; /app redirects to /login if signed out.
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0b0d",
    theme_color: "#0b0b0d",
    categories: ["productivity", "utilities"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
