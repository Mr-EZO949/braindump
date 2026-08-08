import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.4"],
  // sharp is a native module — keep it external so it isn't bundled by the
  // server compiler (used by /api/images for server-side resize).
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
