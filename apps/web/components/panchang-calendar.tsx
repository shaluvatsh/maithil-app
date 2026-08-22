'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/modal';
import { readTithi } from '@/lib/tithi';
import { todayIso } from '@/lib/format';

/**
 * A month grid, with the selected day expanded beneath it.
 *
 * Two things were wrong with the first version. It rendered a 30-row table, which
 * is the right shape for comparing sunrise times and the wrong one for "where in
 * the month does this fall" — you cannot see a fortnight in a list. And every cell
 * was a link straight into `/book`, so a devotee who tapped a date to *read* it was
 * thrown into a checkout. Looking up a tithi is the commonest reason to open this
 * page and it is not a booking intent; the booking is one deliberate tap further.
 */
export interface CalendarDay {
  date: string;
  bengaliDate: string | null;
  tithiAtSunrise: string;
  nakshatraAtSunrise: string;
  sunrise?: string;
  sunset?: string;
  abhijit: { startsAt: string; endsAt: string } | null;
  rahuKaal: { startsAt: string; endsAt: string } | null;
  auspiciousForRitualIds: string[];
  schoolsDisagree?: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local calendar date, not `toISOString()` — that is UTC and rolls over early in IST. */
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const longDate = (iso: string) =>
  new Date(`${iso}T12:00`).toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function PanchangCalendar({
  days, time, badgeFor, children, cta, ritualsById,
}: {
  days: CalendarDay[];
  time: (iso: string) => string;
  /**
   * A short mark per cell, supplied by the role.
   *
   * A devotee needs "auspicious"; a purohit needs "3 open, 1 booked"; an operator
   * needs "thin". Same grid, same dates — the calendar does not decide which of
   * those matters, because it cannot know who is reading it.
   */
  badgeFor?: (date: string) => { text: string; tone?: 'ok' | 'warn' | 'bad' } | null;
  /** Extra content inside the day panel, below the timings. */
  children?: (date: string) => React.ReactNode;
  /** The day panel's action. Null for roles that are not buying anything. */
  cta?: ((date: string) => React.ReactNode) | null;
  /**
   * Resolves the ritual ids the panchang marks auspicious into something a reader
   * can act on. Without it the day panel can only say "auspicious for 14 rituals",
   * which is a number nobody can do anything with.
   */
  ritualsById?: Map<string, { slug: string; name: string }>;
}) {
  const today = todayIso();
  // Opens on today when it is in the window, so the page answers "what is today"
  // before anyone touches it — the question most visitors arrive with.
  const [selected, setSelected] = useState<string | null>(null);
  const [showRituals, setShowRituals] = useState(false);

  if (days.length === 0) return null;

  const byDate = new Map(days.map((d) => [d.date, d]));
  const open = selected ?? (byDate.has(today) ? today : days[0]!.date);
  const day = byDate.get(open);

  const first = new Date(`${days[0]!.date}T12:00`);
  const last = new Date(`${days.at(-1)!.date}T12:00`);

  // Whole weeks, so the grid always has seven columns and never a ragged edge.
  const start = new Date(first);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const cells: Date[] = [];
  for (let c = new Date(start); c <= end; c.setDate(c.getDate() + 1)) cells.push(new Date(c));

  let lastMonth = '';

  return (
    <div className="cal">
      <div className="cal-head">
        {WEEKDAYS.map((w) => <span key={w} className="cal-dow">{w}</span>)}
      </div>

      <div className="cal-grid" role="grid" aria-label="Panchang calendar">
        {cells.map((c) => {
          const iso = isoLocal(c);
          const d = byDate.get(iso);
          const monthLabel = c.toLocaleDateString('en-IN', { month: 'short' });
          const showMonth = monthLabel !== lastMonth;
          if (d) lastMonth = monthLabel;

          // Outside the fetched window: drawn so the weeks line up, but inert.
          if (!d) return <span key={iso} className="cal-cell empty" aria-hidden />;

          const moon = readTithi(d.tithiAtSunrise);
          const good = d.auspiciousForRitualIds.length > 0;

          return (
            <button
              key={iso}
              type="button"
              onClick={() => setSelected(iso)}
              aria-pressed={iso === open}
              className={[
                'cal-cell',
                good ? 'good' : '',
                iso === today ? 'today' : '',
                iso === open ? 'open' : '',
                d.schoolsDisagree ? 'differs' : '',
              ].filter(Boolean).join(' ')}
              aria-label={
                `${longDate(iso)} — ${d.tithiAtSunrise}, ${d.nakshatraAtSunrise}`
                + `${good ? '. Auspicious' : ''}`
              }
            >
              <span className="c-top">
                <span className="c-num">
                  {showMonth && <span className="c-mon">{monthLabel} </span>}
                  {c.getDate()}
                </span>
                {moon && <span className="c-moon" aria-hidden>{moon.glyph}</span>}
              </span>
              <span className="c-tithi">{d.tithiAtSunrise}</span>
              {d.bengaliDate && <span className="c-era">{d.bengaliDate}</span>}
              {(() => {
                const b = badgeFor?.(iso);
                return b ? <span className={`c-badge ${b.tone ?? 'ok'}`}>{b.text}</span> : null;
              })()}
              {good && !badgeFor && <span className="c-dot" aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="cal-legend">
        <span><i className="sw good" /> Auspicious for at least one ritual</span>
        <span><i className="sw today" /> Today</span>
        <span><i className="sw differs" /> Almanacs disagree</span>
      </div>

      {/* The reading surface. A tap on the grid lands here, not in a checkout. */}
      {day && (
        <div className="cal-detail" role="region" aria-live="polite">
          <div className="cd-head">
            <div>
              <span className="cd-when">
                {open === today ? 'Today · ' : ''}{longDate(open)}
              </span>
              <h3>{day.tithiAtSunrise}</h3>
              <p className="muted">
                {day.nakshatraAtSunrise} nakshatra
                {day.bengaliDate ? ` · ${day.bengaliDate}` : ''}
              </p>
            </div>
            {/*
              A count is not an answer. "Auspicious for 14 rituals" told a devotee
              a number and gave them nowhere to go with it — they still had to open
              the catalogue and guess which fourteen. It is now the way in to
              exactly those fourteen, on exactly this day.
            */}
            {day.auspiciousForRitualIds.length > 0 && (
              <button
                type="button"
                className="cd-auspicious"
                onClick={() => setShowRituals(true)}
                aria-haspopup="dialog"
              >
                <span className="tag auspicious">
                  Auspicious for {day.auspiciousForRitualIds.length}{' '}
                  ritual{day.auspiciousForRitualIds.length === 1 ? '' : 's'}
                </span>
                <span className="cd-aus-more">See which ›</span>
              </button>
            )}
          </div>

          <dl className="cd-times">
            {day.sunrise && (
              <div><dt>Sunrise</dt><dd>{time(day.sunrise)}</dd></div>
            )}
            {day.sunset && (
              <div><dt>Sunset</dt><dd>{time(day.sunset)}</dd></div>
            )}
            {day.abhijit && (
              <div className="good">
                <dt>Abhijit · best</dt>
                <dd>{time(day.abhijit.startsAt)}–{time(day.abhijit.endsAt)}</dd>
              </div>
            )}
            {day.rahuKaal && (
              <div className="bad">
                <dt>Rahu Kaal · avoid</dt>
                <dd>{time(day.rahuKaal.startsAt)}–{time(day.rahuKaal.endsAt)}</dd>
              </div>
            )}
          </dl>

          {day.schoolsDisagree && (
            <p className="notice warn">
              The almanacs do not agree about this date. We mark it rather than
              choosing for you — check with your purohit before fixing a wedding or
              upanayan on it.
            </p>
          )}

          {children?.(open)}

          {/* Booking is one deliberate step, from the day actually chosen — and
              only for the role that books. A purohit's action here is opening a
              slot, an operator's is nothing at all. */}
          {showRituals && day && (
            <Modal title={`Good for these on ${longDate(open)}`}
                   onClose={() => setShowRituals(false)}>
              <p className="muted" style={{ fontSize: '.9rem' }}>
                The panchang marks this day auspicious for the rituals below. Picking
                one carries the date into the booking.
              </p>
              <ul className="aus-list">
                {day.auspiciousForRitualIds.map((id) => {
                  const r = ritualsById?.get(id);
                  return (
                    <li key={id}>
                      {r ? (
                        <Link href={`/book?ritual=${r.slug}&day=${open}`}>
                          <span className="aus-name">{r.name}</span>
                          <span className="aus-go" aria-hidden>›</span>
                        </Link>
                      ) : (
                        /* The catalogue has not loaded, or this ritual is no longer
                           offered in this city. Naming the id would be noise. */
                        <span className="aus-name muted">A ritual no longer offered here</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Modal>
          )}

          {cta === undefined
            ? (
              <Link href={`/book?day=${open}&browse=1`} className="btn">
                Book a pooja on this day
              </Link>
            )
            : cta?.(open)}
        </div>
      )}
    </div>
  );
}
