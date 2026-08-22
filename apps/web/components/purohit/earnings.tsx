'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';

/**
 * What a purohit is owed.
 *
 * `GET /v1/me/earnings` has existed since the payout job was built and nothing has
 * ever rendered it. A purohit could see the jobs they had done and had no way to
 * find out what they were owed for them — which is the single thing a working
 * purohit cares about most, and the reason supply churns off a marketplace.
 *
 * The breakdown matters more than the total. Cash jobs mean the purohit already
 * holds the devotee's money and OWES the platform its commission, so "gross" and
 * "what lands in your account" differ by an amount they did not receive and cannot
 * see. Showing only the net turns a legible deduction into an unexplained shortfall,
 * and that is what a support call is made of.
 */
export interface Earnings {
  grossPaise: number;
  duesPaise: number;
  tdsCarryPaise: number;
  alreadyPaidPaise: number;
  netPayablePaise: number;
}

export function EarningsPanel() {
  const { money } = useRegion();
  const [data, setData] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Earnings>('/v1/me/earnings')
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="card"><p className="muted">Loading your earnings…</p></div>;
  if (error) {
    return (
      <div className="notice err">
        <strong>Could not load your earnings.</strong> {error}
      </div>
    );
  }
  if (!data) return null;

  const owesUs = data.duesPaise > 0;

  return (
    <section className="earn" aria-labelledby="earn-h">
      <div className="earn-head">
        <div>
          <span className="earn-kicker">Your money</span>
          <h2 id="earn-h">
            {money(data.netPayablePaise)}
            <span className="earn-unit"> to be paid out</span>
          </h2>
        </div>
      </div>

      <dl className="earn-lines">
        <div>
          <dt>Earned on completed pujas</dt>
          <dd>{money(data.grossPaise)}</dd>
        </div>

        {/*
          The line that has to be spelled out. On a cash job the devotee pays the
          purohit directly, so the platform's commission is money the purohit is
          holding on our behalf — not a fee taken from them twice.
        */}
        {owesUs && (
          <div className="owed">
            <dt>
              Commission on cash jobs
              <span className="earn-note muted">
                You collected this from the devotee, so it comes out of your payout
              </span>
            </dt>
            <dd>−{money(data.duesPaise)}</dd>
          </div>
        )}

        {data.tdsCarryPaise > 0 && (
          <div>
            <dt>
              TDS withheld
              <span className="earn-note muted">
                Deducted under section 194-O and paid to the department against your PAN
              </span>
            </dt>
            <dd>−{money(data.tdsCarryPaise)}</dd>
          </div>
        )}

        {data.alreadyPaidPaise > 0 && (
          <div>
            <dt>Already paid to you</dt>
            <dd>−{money(data.alreadyPaidPaise)}</dd>
          </div>
        )}

        <div className="net">
          <dt>Payable now</dt>
          <dd>{money(data.netPayablePaise)}</dd>
        </div>
      </dl>

      {data.netPayablePaise === 0 && data.grossPaise === 0 && (
        <p className="muted earn-empty">
          Nothing yet — this fills in as you complete pujas.
        </p>
      )}

      <p className="earn-terms muted">
        Payouts run weekly. Cash you collect from a devotee is yours to keep; the
        commission on it is settled out of your next payout rather than billed to you.
      </p>
    </section>
  );
}
