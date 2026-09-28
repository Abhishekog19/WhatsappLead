import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Contacts' };

export default function ContactsPage() {
  return (
    <ComingSoon
      title="Contacts"
      description="Upload an Excel or CSV file, map its columns, and review what was imported. Also where your do-not-contact list lives."
      phase="phase 2"
    />
  );
}
