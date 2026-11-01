'use client';
import { SiteFooter } from '@/components/footer';
import { WhatsAppFloat } from '@/app/nav';
import { navFor } from '@/lib/nav-model';
import { useRole } from '@/lib/use-role';

/**
 * The shop's chrome — the marketing footer and the "Chat with us" float — shown
 * only to the people it is addressed to.
 *
 * Both used to render unconditionally from `layout.tsx`, so an ops admin reading
 * the ledger was offered "Something wrong with a booking? WhatsApp us" and fourteen
 * city chips, and a purohit got a support float sitting on top of his own payout
 * form on a phone. Neither is buying a puja.
 *
 * The decision itself is `navFor(role).consumerChrome`, not a condition written
 * here: the header has always branched per role from that table, and a second
 * place to answer "what does this role see" is how the two drift apart.
 */
export function ConsumerChrome() {
  const role = useRole();
  if (!navFor(role).consumerChrome) return null;
  return (
    <>
      <SiteFooter />
      <WhatsAppFloat />
    </>
  );
}
