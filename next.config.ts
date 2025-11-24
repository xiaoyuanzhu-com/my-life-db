import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
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
      {
        protocol: 'https',
        hostname: 'www.gravatar.com',
        pathname: '/avatar/**',
      },
    ],
    // For production, you would add your domain here
  },
  experimental: {
    // Increase body size limit for TUS resumable uploads
    // Using 20mb to accommodate our 10MB chunk size + overhead
    middlewareClientMaxBodySize: '20mb',
  },
};

export default nextConfig;
