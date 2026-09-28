import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Messages' };

export default function TemplatesPage() {
  return (
    <ComingSoon
      title="Messages"
      description="Write your message with placeholders like {{Name}}, add variants so not everyone receives identical text, and preview against a real row from your sheet."
      phase="phase 2"
    />
  );
}
