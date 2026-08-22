'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, auth } from '@/lib/api';
import { emojiFor } from '@themaithil/region';

/**
 * Pujas this household did last year, coming round again.
 *
 * Almost every ritual on this platform is annual — Lakshmi Puja each Diwali, a
 * shraddha on the same tithi each year — and the product's answer to that was to
 * make a returning family search the catalogue from scratch, treating the most
 * predictable demand in the business as a cold visit. The blueprint called the
 * ritual calendar the business model; this is the smallest honest piece of it.
 *
 * Renders nothing for a guest, and nothing for a devotee with no history. A
 * "welcome back" band addressed to somebody who has never booked is worse than an
 * absent one.
 */
export interface Anniversary {
  slug: string;
  name: string;
  lastBookedOn: string;
  daysSince: number;
  times: number;
  dueNow: boolean;
}

export function Anniversaries() {
  const [items, setItems] = useState<Anniversary[]>([]);

  useEffect(() => {
    // Only a signed-in devotee has a history to have an anniversary in.
    if (!auth.token || auth.role === 'pandit' || auth.role === 'admin') return;
    api<Anniversary[]>('/v1/me/anniversaries')
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="section tight">
      <div className="wrap">
        <div className="rail-head">
          <div>
            <h2>Around this time last year</h2>
            <p className="muted">
              These come round on the tithi, not the date — we&apos;ll find the day.
            </p>
          </div>
        </div>

        <ul className="anniv">
          {items.map((a) => (
            <li key={a.slug}>
              {/*
                Straight to the date step for this ritual. A family repeating a puja
                they have already chosen twice does not need the catalogue again.
              */}
              <Link href={`/book?ritual=${a.slug}`} className="anniv-card">
                <span className="av-emoji" aria-hidden>{emojiFor(a.slug)}</span>
                <span className="av-body">
                  <span className="av-name">{a.name}</span>
                  <span className="av-when muted">
                    Last done{' '}
                    {new Date(`${a.lastBookedOn}T12:00`).toLocaleDateString('en-IN',
                      { month: 'long', year: 'numeric' })}
                    {a.times > 1 ? ` · ${a.times} times with us` : ''}
                  </span>
                </span>
                {a.dueNow && <span className="av-due">Due now</span>}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
