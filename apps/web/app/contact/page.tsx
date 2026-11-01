import type { Metadata } from 'next';
import Link from 'next/link';
import { whatsappLink, EMAIL } from '@/lib/contact';

export const metadata: Metadata = {
  title: 'Contact us — TheMaithil',
  description: 'Reach us about a booking, to list as a pandit, or about anything else.',
};


/**
 * Contact, routed by intent.
 *
 * A single "get in touch" address makes the person on the other end triage, and
 * makes the sender guess. Splitting by what they actually want — a booking that has
 * gone wrong, listing as a pandit, everything else — is one screen of work and
 * removes a round trip from every message.
 *
 * WhatsApp first: the market is WhatsApp-first and so is the notification pipeline.
 */
export default function ContactPage() {
  return (
    <div className="wrap legal">
      <h1>Contact us</h1>
      <p className="sub">
        We answer on WhatsApp fastest. Please include your booking date and the
        pandit&apos;s name if it is about a booking.
      </p>

      <div className="contact-grid">
        <div className="card">
          <h2>Something wrong with a booking</h2>
          <p className="muted">
            A pandit has not arrived, a code is not working, or the amount looks
            wrong. This is the fastest route and we treat it first.
          </p>
          <a className="btn"
             href={whatsappLink('Hello, I need help with a booking. My booking date is: ')}>
            WhatsApp us
          </a>
        </div>

        <div className="card">
          <h2>You are a pandit</h2>
          <p className="muted">
            To list your practice, you can register directly — it takes a few minutes
            and an admin verifies your account before any devotee can book you.
          </p>
          <Link className="btn outline" href="/login">Register as a pandit</Link>
        </div>

        <div className="card">
          <h2>Anything else</h2>
          <p className="muted">
            Partnerships, press, a complaint about how we handled something, or a
            question that does not fit above.
          </p>
          <a className="btn outline" href={`mailto:${EMAIL}`}>{EMAIL}</a>
        </div>
      </div>

      <section>
        <h2>Before you write</h2>
        <p>
          Two things you can do yourself:{' '}
          <Link href="/account?tab=bookings">cancel a booking</Link> from your
          account — the refund is shown before you confirm — and check{' '}
          <Link href="/terms">terms and refunds</Link> for what you get back and when.
        </p>
      </section>
    </div>
  );
}
