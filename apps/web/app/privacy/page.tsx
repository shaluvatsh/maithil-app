import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy — TheMaithil',
  description: 'What we hold about you, who sees it, and how long we keep it.',
};

/**
 * Privacy, describing what the system actually stores.
 *
 * Written against the schema rather than a template: phone and name on `users`,
 * venue on `addresses`, the panjika preference, and the booking history with its
 * price snapshot. Two things here are honest admissions rather than reassurances —
 * the retention conflict between DPDP and GST, and the fact that deletion and
 * export endpoints are not built yet. Both are open items in PRODUCTION.md.
 */
export default function PrivacyPage() {
  return (
    <div className="wrap legal">
      <h1>Privacy</h1>
      <p className="sub">
        What we hold, who sees it, and how long we keep it — in plain terms.
      </p>

      <section>
        <h2>What we hold</h2>
        <ul className="ticks">
          <li>Your name and mobile number, because that is how a pandit reaches you</li>
          <li>The address you book to, so the pandit can get there</li>
          <li>Which almanac your family follows, to mark the right dates</li>
          <li>Your bookings, with the price as it stood on the day you agreed it</li>
        </ul>
        <p>
          We do not hold your card details. Payments go to our payment provider and
          we keep only a reference.
        </p>
      </section>

      <section>
        <h2>Who sees it</h2>
        <p>
          <strong>Your assigned pandit</strong> sees your name, your address and your
          phone number — they cannot arrive otherwise. They see this only for a
          booking assigned to them. Pandits who were not assigned see nothing about
          you.
        </p>
        <p>
          <strong>Our staff</strong> can see bookings and ledger entries to resolve
          problems and to reconcile money. <strong>Nobody else.</strong> We do not
          sell your data and we do not run advertising against it.
        </p>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <p>
          There is a genuine tension here and we would rather state it than hide it.
          Data protection law expects us to delete your data when you ask. Tax law
          requires invoices and the financial record behind them to be retained for
          several years.
        </p>
        <p>
          Where the two conflict, the financial record wins and we keep it — but we
          strip it back to what the law requires, removing your address and
          contact details and keeping the transaction itself.
        </p>
      </section>

      <section>
        <h2>What is not built yet</h2>
        <p>
          Self-service data export and deletion are <strong>not implemented</strong>.
          Until they are, <Link href="/contact">write to us</Link> and we will do it
          by hand. We would rather tell you that than imply a button exists.
        </p>
      </section>

      <p className="faint" style={{ marginTop: 34 }}>
        This describes current practice. It has not been reviewed by a lawyer and is
        not a legal notice under the DPDP Act.
      </p>
    </div>
  );
}
