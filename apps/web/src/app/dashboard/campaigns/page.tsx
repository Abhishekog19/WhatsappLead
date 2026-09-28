import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Campaigns' };

export default function CampaignsPage() {
  return (
    <ComingSoon
      title="Campaigns"
      description="Pick a contact list, a message and a number, then watch sending progress live — including which people were skipped and why."
      phase="phase 3"
    />
  );
}
