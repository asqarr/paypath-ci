import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@paypath/core",
    "@paypath/demo-engine",
    "@paypath/stripe-adapter",
    "@paypath/supabase-adapter",
  ],
};

export default nextConfig;
