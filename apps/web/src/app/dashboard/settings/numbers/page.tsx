import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'WhatsApp numbers' };

export default function NumbersPage() {
  return (
    <ComingSoon
      title="WhatsApp numbers"
      description="Link a number by entering it here and typing the 8-character code WhatsApp gives you into Settings → Linked Devices → Link with phone number instead. No QR code, so one phone is enough."
      phase="phase 1"
    />
  );
}
