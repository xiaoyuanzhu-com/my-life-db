import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Allow loading images from our own API routes
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3000',
        pathname: '/raw/**',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3000',
        pathname: '/sqlar/**',
      },
    ],
    // For production, you would add your domain here
  },
};

export default nextConfig;
