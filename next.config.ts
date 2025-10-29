import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    nodeMiddleware: true,
  },
  images: {
    // Allow loading images from our own API routes
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3000',
        pathname: '/api/files/**',
      },
    ],
    // For production, you would add your domain here
  },
};

export default nextConfig;
