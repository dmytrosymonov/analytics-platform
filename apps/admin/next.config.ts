import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: process.env.NEXT_BASE_PATH || '',
};

export default nextConfig;
