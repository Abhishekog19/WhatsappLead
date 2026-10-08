import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'WhatsApp Outreach',
    template: '%s · WhatsApp Outreach',
  },
  description:
    'Upload a contact sheet, link WhatsApp from your phone, and send personalised messages at a safe pace — all from the browser.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The app is a tool, not a document: zoom stays enabled for accessibility,
  // but the layout never requires it.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
