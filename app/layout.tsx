import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import '../public/styles.css';
import '../public/architecture.css';
import './architecture/simple.css';

export const metadata: Metadata = {
  title: 'ViewPoint | Explore repository architecture',
  description: 'Map a GitHub repository and explore its architecture and source connections. Built with IBM Bob.',
  icons: { icon: '/logo.svg?v=3' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" data-theme="dark" suppressHydrationWarning><body><Suspense fallback={<p role="status">Loading…</p>}>{children}</Suspense></body></html>;
}
