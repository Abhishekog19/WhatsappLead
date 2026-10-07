import type { NextConfig } from 'next';
import { loadEnvFile } from '@wa/core';

/**
 * Next only reads `.env` from this app's own directory, but the repository
 * keeps one at the root so Compose can use the same file for interpolation.
 * Loading it here puts it in place for `next dev` and `next start`.
 *
 * Not a substitute for real configuration: the standalone production server
 * does not execute this file, and in the container Compose supplies the
 * environment anyway.
 */
loadEnvFile();

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * The workspace packages ship TypeScript source rather than compiled output,
   * so Next has to run them through its own compiler.
   */
  transpilePackages: ['@wa/core', '@wa/db'],

  serverExternalPackages: ['postgres'],

  // Long-lived SSE responses (live pairing code, campaign progress) must not
  // be buffered or the browser sees nothing until the stream closes.
  async headers() {
    return [
      {
        source: '/api/:path*/stream',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-transform' },
          { key: 'X-Accel-Buffering', value: 'no' },
        ],
      },
      {
        // Baseline hardening. The app renders no third-party content and
        // embeds nothing, so the policy can be strict.
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },

  output: 'standalone',
};

export default config;
