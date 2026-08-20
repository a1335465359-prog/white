import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure fs/path operations in API routes work correctly
  serverExternalPackages: ["pg"],
};

export default nextConfig;
