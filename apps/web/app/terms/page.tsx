import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms and refunds — TheMaithil',
  description:
    'What you pay, when you pay it, and exactly what you get back if a booking '
    + 'is cancelled — by you or by us.',
};

/**
 * Terms, written from the code rather than from a template.
 *
 * Every number here is one the system actually enforces: the refund tiers come
 * from `computeRefund` in packages/contracts, the substitution behaviour from
 * ADR 0012, the auto-accept rule from ADR 0011. A terms page that disagrees with
 * the software is worse than none, so if any of this changes, that function and
 * this page change together.
 */
export default function TermsPage() {
  return (
    <div className="wrap legal">
      <h1>Terms and refunds</h1>
      <p className="sub">
        The short version: you pay a small amount to hold your slot, the rest on the
        day. If we fail you, you get everything back.
      </p>

      <section>
        <h2>What you pay</h2>
        <p>
          Every booking is itemised before you pay anything — the pandit&apos;s
          dakshina, materials at catalogue cost plus a 5% sourcing charge if you ask
          us to bring them, travel where it applies, and our service fee. There is no
          package price, and no charge that appears later.
        </p>
        <p>
          You pay a <strong>booking amount online</strong> to hold the slot. The
          balance is either cash to the pandit on the day, or charged online on
          completion — whichever you chose. The cash figure is fixed at booking and
          confirmed again by your completion code, so nothing is negotiated at
          your door.
        </p>
      </section>

      <section>
        <h2>If you cancel</h2>
        <table className="legal-table">
          <thead><tr><th>When</th><th>What you get back</th></tr></thead>
          <tbody>
            <tr><td>More than 48 hours before</td><td>Everything you paid</td></tr>
            <tr><td>Between 24 and 48 hours</td><td>Half of what you paid</td></tr>
            <tr><td>Less than 24 hours</td><td>The booking amount is retained</td></tr>
          </tbody>
        </table>
        <p className="muted">
          Inside 24 hours the pandit has usually turned other work away and may have
          bought perishable samagri, which is what the retained amount covers.
        </p>
      </section>

      <section>
        <h2>If your pandit cancels</h2>
        <p>
          <strong>You are made whole, always — including inside 24 hours.</strong>
          There is no notice period that reduces this, because a cancellation on our
          side is not your problem.
        </p>
        <p>
          First we try not to cancel at all. If your pandit cannot attend, we
          reassign the booking to the next best-matched pandit for your vidhi,
          language and area, at <strong>the same price and the same slot</strong>. You
          keep your booking and we tell you the new name. A substitution never
          increases what you pay, even if the replacement&apos;s own rate is higher.
        </p>
        <p>
          Only if nobody can take it do we cancel, refund you in full, and contact
          you.
        </p>
      </section>

      <section>
        <h2>How pandits are assigned</h2>
        <p>
          You do not pick from a list. We assign the best match for your family&apos;s
          vidhi and language, nearest to you, weighing rating, distance, reliability
          and experience — and we tell you who it is, with the reason, before you pay.
          You can also book a specific pandit directly from their profile.
        </p>
        <p>
          A pandit who has published a slot is committed to it: booking an open slot
          confirms it immediately, with no waiting to be accepted.
        </p>
      </section>

      <section>
        <h2>Dates and the panchang</h2>
        <p>
          Auspicious dates are marked according to the almanac your family follows.
          Where two almanacs disagree we show you both rather than choosing for you.
          Computed timings are accurate to within tens of minutes — for a wedding
          lagna, confirm with your pandit.
        </p>
      </section>

      <section>
        <h2>Getting in touch</h2>
        <p>
          Anything that has gone wrong with a booking, tell us and we will fix it:{' '}
          <Link href="/contact">contact us</Link>.
        </p>
      </section>

      <p className="faint" style={{ marginTop: 34 }}>
        These terms describe how the service behaves today. This is not legal advice,
        and the document has not been reviewed by a lawyer.
      </p>
    </div>
  );
}
