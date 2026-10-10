import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  devIndicators: false,
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
