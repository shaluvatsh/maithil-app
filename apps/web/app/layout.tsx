import './globals.css';
import type { Metadata } from 'next';
import { RegionProvider } from '@/lib/region-context';
import { Nav } from './nav';
import { ConsumerChrome } from '@/components/consumer-chrome';
import { LanguageOffer } from '@/components/language-offer';
import { RoleGate } from '@/components/role-gate';

export const metadata: Metadata = {
  // Lets every page set a relative `openGraph.images` path (e.g. `/images/...`)
  // and have Next resolve it to an absolute URL for the crawlers and chat apps
  // that require one — without any page hardcoding the site's own domain.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'),
  title: 'TheMaithil — Spiritual Services at Your Doorstep',
  description:
    'Book authentic poojas and ceremonies with verified pandits. Doorstep service, flexible scheduling and transparent pricing across India.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Pan-India: every city is live and the user picks. The region drives
            catalogue, panchang, slot shape, language and pricing. */}
        <RegionProvider>
          <Nav />
          {/* Offered once, in the language being offered, then never again. It
              replaced a permanent header control — see components/language-offer. */}
          <LanguageOffer />
          {/* Wrong-door redirect, not a security boundary — see components/role-gate.
              The boundary is the API's @Roles guard, which verifies the JWT. */}
          <RoleGate>{children}</RoleGate>
          {/* Footer + support float, for the roles they are addressed to. */}
          <ConsumerChrome />
        </RegionProvider>
      </body>
    </html>
  );
}
