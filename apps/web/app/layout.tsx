import './globals.css';
import type { Metadata } from 'next';
import { RegionProvider } from '@/lib/region-context';
import { Nav, WhatsAppFloat } from './nav';
import { SiteFooter } from '@/components/footer';
import { RoleGate } from '@/components/role-gate';

export const metadata: Metadata = {
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
          {/* Wrong-door redirect, not a security boundary — see components/role-gate.
              The boundary is the API's @Roles guard, which verifies the JWT. */}
          <RoleGate>{children}</RoleGate>
          <SiteFooter />
          <WhatsAppFloat />
        </RegionProvider>
      </body>
    </html>
  );
}
