import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  experimental: {
    cpus: 2,
    webpackMemoryOptimizations: true,
    // Also avoid OS child-process pools if Next is invoked outside npm scripts.
    turbopackPluginRuntimeStrategy: "workerThreads",
  },
  devIndicators: false,
};

export default nextConfig;
