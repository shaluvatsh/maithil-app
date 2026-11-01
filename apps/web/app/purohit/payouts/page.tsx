'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PayoutAccountPanel } from '@/components/purohit/payout-account';
import { EarningsPanel } from '@/components/purohit/earnings';
import { api, auth } from '@/lib/api';

/**
 * Money, on its own page.
 *
 * THE BUG THIS ALSO FIXES, found while moving it here. Three of the dashboard's own
 * "Fix this" links (`cash_jobs_paused`, `cash_headroom_low`) pointed at
 * `/purohit#earnings` — a fragment that named nothing. The earnings section had no
 * `id="earnings"` anywhere on that page, so the link navigated and then scrolled
 * nowhere; a purohit tapping "Fix this" landed back at the top of their job list
 * with no sign anything had happened. It is a real route now.
 *
 * `PayoutAccountPanel` already collapses to a one-line summary once an account is
 * linked — see its own comment, "a once-ever task used to open itself above the
 * work" — which is the exact pattern this session applied to My Practice. Nothing
 * about this component changed; it only moved to a page of its own.
 */
export default function PurohitPayoutsPage() {
  const router = useRouter();
  const [completed, setCompleted] = useState(0);

  useEffect(() => {
    if (!auth.token) { router.replace('/login?next=/purohit/payouts'); return; }
    void api<Array<{ state: string }>>('/v1/bookings?locale=en')
      .then((bs) => setCompleted(bs.filter((b) => b.state === 'completed' || b.state === 'reviewed').length))
      .catch(() => setCompleted(0));
    // Mount-once: `useRouter()` is a fresh object every render (see the test mock
    // in `__tests__/setup.tsx`), so depending on `router` here re-fires this fetch
    // on every render forever — see the identical fix in `../rates/page.tsx`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <Link href="/purohit" className="btn-link" style={{ display: 'inline-block', marginBottom: 14 }}>
        ← My jobs
      </Link>
      <h1>Payouts</h1>
      <p className="sub">Where your money goes, and what you are owed.</p>

      <PayoutAccountPanel />

      <h2 id="earnings">Earnings</h2>
      <p className="sub">
        {completed === 0
          ? 'Nothing completed yet — this fills in as you finish pujas.'
          : `${completed} puja${completed === 1 ? '' : 's'} completed.`}
      </p>
      <EarningsPanel />
    </div>
  );
}
