// Generates PWA PNG icons from public/logo_icon.svg.
// Run once (or whenever the logo changes): node scripts/gen-pwa-icons.mjs
//
// The source logo is transparent red line-art; PWA/iOS icons should be
// opaque, so we composite it centered on the app's dark background. Maskable
// uses extra padding so Android's adaptive-icon mask never clips the mark.

import sharp from "sharp";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "public", "logo_icon.svg");
const OUT_DIR = path.join(ROOT, "public", "icons");
const BG = { r: 11, g: 11, b: 13, alpha: 1 }; // #0b0b0d — app background

const TARGETS = [
  { file: "icon-192.png", size: 192, scale: 0.72 },
  { file: "icon-512.png", size: 512, scale: 0.72 },
  // Maskable: keep the mark inside the ~80% safe zone (Android masks the rest).
  { file: "icon-maskable-512.png", size: 512, scale: 0.5 },
  // iOS home-screen icon (opaque; iOS applies its own rounding).
  { file: "apple-touch-icon.png", size: 180, scale: 0.7 },
];

const svg = await readFile(SRC);
await mkdir(OUT_DIR, { recursive: true });

for (const { file, size, scale } of TARGETS) {
  const logoSize = Math.round(size * scale);
  const logo = await sharp(svg, { density: 384 })
    .resize(logoSize, logoSize, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(path.join(OUT_DIR, file));

  console.log(`✓ ${file} (${size}×${size}, logo ${logoSize}px)`);
}

console.log("PWA icons written to public/icons/");
