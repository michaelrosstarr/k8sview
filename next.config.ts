import type { NextConfig } from "next";

// Tauri serves the static `out/` directory, so there is no Node server at runtime.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
