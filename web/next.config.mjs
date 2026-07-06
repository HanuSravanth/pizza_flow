/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Verification builds (CI, review tooling) set NEXT_DIST_DIR to keep their
  // output away from the .next folder a running `next dev` depends on —
  // sharing it corrupts the dev server's chunk graph mid-session.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
