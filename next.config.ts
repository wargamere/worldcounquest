import type { NextConfig } from 'next';

/**
 * GitHub Pages serves a project site from /<repo>, so every asset needs that
 * prefix. It is passed in by the deploy workflow and left empty locally.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  // Static export: there is no backend, so the whole game ships as flat files.
  output: 'export',
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
