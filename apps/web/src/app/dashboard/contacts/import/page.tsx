import type { Metadata } from 'next';
import Link from 'next/link';
import { ImportWizard } from './import-wizard';

export const metadata: Metadata = { title: 'Import contacts' };

export default function ImportPage() {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/contacts" className="hint underline underline-offset-2">
          ← Contacts
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Import contacts</h1>
      </div>

      <ImportWizard />
    </div>
  );
}
