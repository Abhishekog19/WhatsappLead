'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Bottom tab bar — the primary navigation on a phone, promoted to a sidebar
 * on wide screens. Placed at the bottom because that is where a thumb reaches.
 */

type Tab = {
  href: string;
  label: string;
  icon: () => React.ReactElement;
  /** Home matches only itself; every other tab owns its whole subtree. */
  exact?: boolean;
};

const TABS: readonly Tab[] = [
  { href: '/dashboard', label: 'Home', icon: HomeIcon, exact: true },
  { href: '/dashboard/campaigns', label: 'Campaigns', icon: SendIcon },
  { href: '/dashboard/contacts', label: 'Contacts', icon: PeopleIcon },
  { href: '/dashboard/templates', label: 'Messages', icon: ChatIcon },
  { href: '/dashboard/settings', label: 'Settings', icon: GearIcon },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/90 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-950/90 sm:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-lg">
        {TABS.map((tab) => {
          const active = tab.exact
            ? pathname === tab.href
            : pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                  active
                    ? 'text-brand-600 dark:text-brand-400'
                    : 'text-neutral-500 dark:text-neutral-400'
                }`}
              >
                <Icon />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function SideNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="hidden w-56 shrink-0 border-r border-neutral-200 p-4 dark:border-neutral-800 sm:block"
    >
      <ul className="space-y-1">
        {TABS.map((tab) => {
          const active = tab.exact
            ? pathname === tab.href
            : pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                    : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900'
                }`}
              >
                <Icon />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* Inline icons: five small paths beat pulling in an icon package. */

const ICON = 'size-5 shrink-0';
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function HomeIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={ICON} {...STROKE}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.8V20h14V9.8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={ICON} {...STROKE}>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={ICON} {...STROKE}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.6M17.5 14.4A5.6 5.6 0 0 1 21 20" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={ICON} {...STROKE}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.1A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={ICON} {...STROKE}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.3-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.4Z" />
    </svg>
  );
}
