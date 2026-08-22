'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { readTithi, notableTithi, nowState, type NowState } from '@/lib/tithi';
import { todayIso } from '@/lib/format';

/**
 * The panchang, split in two.
 *
 * It used to be a single 480px band sitting between the hero and the first
 * bookable thing on the page — so a devotee who arrived wanting to book a puja
 * scrolled past two screens of almanac to reach one. The information is genuinely
 * useful, but almost none of it is useful *before* you have picked a service.
 *
 * So: today's timings become a compact bar, which is the part you glance at, and
 * the month's auspicious dates move below the first rail of services, where they
 * answer "when should I book this" rather than blocking the question.
 */
export interface PanchangDay {
  date: string;
  tithiAtSunrise: string;
  nakshatraAtSunrise: string;
  abhijit: { startsAt: string; endsAt: string } | null;
  rahuKaal: { startsAt: string; endsAt: string } | null;
  auspiciousForRitualIds: string[];
}

/**
 * Today's panchang, and the notable tithis coming up.
 *
 * Sits beside the search box rather than in a band beneath it. The hero's right
 * half was empty space at every width above 900px while the almanac — the one
 * thing on this site nobody else in the category computes in-house — waited below
 * the fold. Putting them on one line costs no vertical space and makes the two
 * reasons to be here visible at once: book something, or check the day.
 */
export function PanchangCard({
  today, upcoming, cityLabel, time, pending,
}: {
  today: PanchangDay | null;
  /** The next few days, for picking out notable tithis. */
  upcoming: PanchangDay[];
  cityLabel: string;
  time: (iso: string) => string;
  /** True while the almanac is still being looked up, as opposed to absent. */
  pending?: boolean;
}) {
  const [now, setNow] = useState<NowState | null>(null);

  useEffect(() => {
    if (!today) return;
    const tick = () => setNow(nowState(new Date(), today.abhijit, today.rahuKaal));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [today]);

  /**
   * Returning null here is how the panchang disappeared in twelve cities without
   * anybody noticing: the nightly job only ever ran for the launch city, every
   * other city fetched an empty array, and the card silently removed itself. An
   * absent feature that leaves no trace cannot be reported as a bug. It now holds
   * its place in the layout and says which of the two things happened.
   */
  if (!today) {
    return (
      <aside className={`pcard-hero quiet${pending ? ' loading' : ''}`} aria-label="Panchang">
        <span className="ph-cap">Panchang · {cityLabel}</span>
        {pending ? (
          <>
            <p className="ph-skel" aria-hidden />
            <p className="ph-skel short" aria-hidden />
            <span className="sr-only">Loading the almanac</span>
          </>
        ) : (
          <>
            <p className="muted">
              We have not published the almanac for {cityLabel} yet. Tithis and
              muhurats are computed per city, so this fills in as we open there.
            </p>
            <Link href="/panchang" className="ph-link">See where it is available ›</Link>
          </>
        )}
      </aside>
    );
  }

  const moon = readTithi(today.tithiAtSunrise);

  // Strictly after today: "upcoming" that includes today is just today twice.
  const notable = upcoming
    .filter((d) => d.date > today.date)
    .map((d) => ({ day: d, label: notableTithi(d.tithiAtSunrise) }))
    .filter((n): n is { day: PanchangDay; label: string } => n.label !== null)
    .slice(0, 3);

  return (
    <aside className="pcard-hero" aria-label="Panchang">
      <div className="ph-top">
        {moon && (
          <span className="ph-moon"
                title={`${moon.label} · ${Math.round(moon.illumination * 100)}% lit`}>
            <span aria-hidden>{moon.glyph}</span>
          </span>
        )}
        <div className="ph-today">
          <span className="ph-cap">Today · {cityLabel}</span>
          <strong className="ph-tithi">{today.tithiAtSunrise}</strong>
          <span className="muted">{today.nakshatraAtSunrise}</span>
        </div>
      </div>

      <div className="ph-windows">
        {today.abhijit && (
          <span className={`ps-win good${now?.kind === 'abhijit' ? ' live' : ''}`}>
            <span className="w-name">Abhijit</span>
            <span className="w-time">{time(today.abhijit.startsAt)}–{time(today.abhijit.endsAt)}</span>
          </span>
        )}
        {today.rahuKaal && (
          <span className={`ps-win bad${now?.kind === 'rahu' ? ' live' : ''}`}>
            <span className="w-name">Rahu Kaal</span>
            <span className="w-time">{time(today.rahuKaal.startsAt)}–{time(today.rahuKaal.endsAt)}</span>
          </span>
        )}
      </div>

      {/* Computed after mount; the server does not know the device's clock. */}
      {now && now.kind !== 'clear' && (
        <p className={`ps-now ${now.kind}`} role="status">
          {now.kind === 'abhijit'
            ? `Auspicious now · until ${time(now.until)}`
            : `Avoid until ${time(now.until)}`}
        </p>
      )}

      {notable.length > 0 && (
        <ul className="ph-list">
          {notable.map(({ day, label }) => (
            <li key={day.date}>
              <Link href={`/book?day=${day.date}&browse=1`}>
                <span className="ph-when">
                  {new Date(`${day.date}T12:00`).toLocaleDateString('en-IN',
                    { day: 'numeric', month: 'short' })}
                </span>
                <span className="ph-name">{label}</span>
                <span className="ph-go" aria-hidden>›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link href="/panchang" className="ph-link">Open full panchang ›</Link>
    </aside>
  );
}

/**
 * Auspicious dates as booking entry points.
 *
 * These were previously read-only rows. A devotee who spotted a good date had no
 * way to act on it and had to re-find it inside the booking flow, which is where
 * an intention goes to die. Each date now carries itself into `/book?day=`.
 */
export function AuspiciousDates({ days }: { days: PanchangDay[] }) {
  if (days.length === 0) return null;

  const monthName = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  // `toISOString()` is UTC and rolls the date over at 05:30 IST, so between
  // midnight and half past five it marked tomorrow as today.
  const today = todayIso();

  return (
    <section className="section tight">
      <div className="wrap">
        <div className="rail-head">
          <div>
            <h2>Good days to book</h2>
            <p className="muted">
              Auspicious dates in {monthName}. Pick one and it carries into your booking.
            </p>
          </div>
          <div className="rail-aside">
            <Link href="/panchang" className="seeall">Full calendar ›</Link>
          </div>
        </div>

        <div className="daystrip">
          {days.map((d) => {
            const when = new Date(`${d.date}T12:00`);
            const moon = readTithi(d.tithiAtSunrise);
            const isToday = d.date === today;
            return (
              <Link
                key={d.date}
                href={`/book?day=${d.date}&browse=1`}
                className={`daychip${isToday ? ' today' : ''}`}
              >
                <span className="d-head">
                  <span className="dow">
                    {isToday ? 'Today' : when.toLocaleDateString('en-IN', { weekday: 'short' })}
                  </span>
                  {moon && <span className="dmoon" aria-hidden>{moon.glyph}</span>}
                </span>
                <span className="dnum">{when.getDate()}</span>
                <span className="dmon">
                  {when.toLocaleDateString('en-IN', { month: 'short' })}
                </span>
                <span className="dtithi">{d.tithiAtSunrise}</span>
                <span className="dcta">Book this day ›</span>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
