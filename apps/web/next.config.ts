import type { NextConfig } from 'next';

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
