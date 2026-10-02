import type { Metadata } from 'next';

// The invite token is in this page's URL. no-referrer keeps it out of the
// Referer header if the student follows any link off the page.
export const metadata: Metadata = {
  title: 'Join',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
