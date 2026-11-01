'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';

/**
 * The same calendar, three questions.
 *
 * `/panchang` rendered one page for everybody. That is defensible for the almanac
 * itself — a tithi is a tithi — but it meant a purohit and an operator were handed
 * a devotee's question and left to do their own job somewhere else, or not at all.
 * The three roles are not looking at different data; they are asking different
 * things of it:
 *
 *   devotee — which days are auspicious, so I can pick one
 *   purohit — which days am I working, and can I close Tuesday afternoon
 *   admin   — which days are about to run out of purohits
 *
 * A purohit's availability and a city's coverage are both keyed by date, so the
 * calendar is the natural place for both. The alternative — a separate availability
 * screen — makes a purohit hold two calendars in their head and cross-reference the
 * almanac they actually plan around.
 */

/* ------------------------------------------------------------------ purohit -- */

export interface DaySlots {
  date: string;
  slots: Array<{
    slotIdx: number;
    status: 'open' | 'closed' | 'booked' | 'blocked';
    bookingId: string | null;
  }>;
}

/**
 * A purohit's own slots for the open day, with a toggle per slot.
 *
 * `setSlots` and `forRange` both existed in the service and neither was reachable
 * over HTTP, so the only control a purohit had was "open my whole calendar". "Mark
 * me unavailable next Tuesday" is the commonest thing a working purohit needs to
 * say and the product had no way to say it.
 */
export interface SlotTime { idx: number; startTime: string; endTime: string }

/** `09:30:00` from Postgres, `9:30 am` for a human. */
const hhmm = (t: string) => {
  const [h = '0', m = '00'] = t.split(':');
  const n = Number(h);
  const suffix = n >= 12 ? 'pm' : 'am';
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve}:${m} ${suffix}`;
};

export function PurohitDay({
  date, slots, slotTimes, onChange, saving, error,
}: {
  date: string;
  slots: DaySlots['slots'] | undefined;
  /** Every slot the city publishes, so a day with no rows can still be offered. */
  slotTimes: SlotTime[];
  onChange: (slotIdx: number, status: 'open' | 'closed') => void;
  saving: number | null;
  error: string | null;
}) {
  const { slotLabel } = useRegion();

  /*
   * Every slot the city runs, whether a row exists for it or not.
   *
   * This used to render only the rows already in `availability`, and those only
   * came from `materialise()` — an all-or-nothing "open my whole calendar for 30
   * days". So a purohit looking at any date outside that window was told "your
   * calendar is not open on this date" and sent to another screen that could only
   * open ALL of them. The one thing supply most needs to say — "I am free on the
   * 20th, morning only" — had nowhere to be said.
   *
   * A slot with no row is `unset`: not closed, just never declared. Tapping it
   * creates it.
   */
  const byIdx = new Map((slots ?? []).map((s) => [s.slotIdx, s]));
  const rows = (slotTimes.length > 0
    ? slotTimes.map((t) => ({
      slotIdx: t.idx,
      when: `${hhmm(t.startTime)} – ${hhmm(t.endTime)}`,
      status: byIdx.get(t.idx)?.status ?? ('unset' as const),
    }))
    : (slots ?? []).map((s) => ({
      slotIdx: s.slotIdx, when: slotLabel(s.slotIdx), status: s.status,
    })));

  if (rows.length === 0) {
    return (
      <div className="pd-empty">
        <p className="muted">This city has no published slot times yet.</p>
      </div>
    );
  }

  return (
    <div className="pd-slots" role="group" aria-label={`Your slots on ${date}`}>
      <p className="pd-lead muted">
        Tap a time to say whether you will take work on this date.
      </p>
      {rows.map((s) => {
        const locked = s.status === 'booked' || s.status === 'blocked';
        const open = s.status === 'open';
        return (
          <button
            key={s.slotIdx}
            type="button"
            className={`pd-slot ${s.status}`}
            disabled={locked || saving === s.slotIdx}
            aria-pressed={open}
            onClick={() => onChange(s.slotIdx, open ? 'closed' : 'open')}
          >
            <span className="pds-time">{s.when}</span>
            <span className="pds-state">
              {s.status === 'booked' ? 'Booked'
                : s.status === 'blocked' ? 'Travel gap'
                : open ? 'Available' : s.status === 'unset' ? 'Not offered' : 'Closed'}
            </span>
            {/* A booked slot is not a toggle. Saying why beats a dead control. */}
            {locked && (
              <span className="pds-note muted">
                {s.status === 'booked' ? 'A devotee is holding this' : 'Set by a nearby booking'}
              </span>
            )}
          </button>
        );
      })}
      {error && <p className="notice err" style={{ gridColumn: '1 / -1' }}>{error}</p>}
    </div>
  );
}

/** Loads the purohit's window once and keeps it in step with their edits. */
export function usePurohitCalendar(from: string, to: string, enabled: boolean) {
  const [days, setDays] = useState<Record<string, DaySlots['slots']>>({});
  const [slotTimes, setSlotTimes] = useState<SlotTime[]>([]);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    api<DaySlots[]>(`/v1/me/purohit/availability?from=${from}&to=${to}`)
      .then((list) => setDays(Object.fromEntries(list.map((d) => [d.date, d.slots]))))
      .catch((e) => setError((e as Error).message));

    /*
     * The shape of a day, independent of whether any row exists for it. Without
     * this the calendar can only render slots that have already been written, and
     * a purohit can never declare a date the materialiser has not reached.
     */
    api<SlotTime[]>('/v1/me/purohit/slot-times')
      .then(setSlotTimes)
      .catch(() => setSlotTimes([]));
  }, [from, to, enabled]);

  const setSlot = async (date: string, slotIdx: number, status: 'open' | 'closed') => {
    setSaving(slotIdx); setError(null);
    // Optimistic: a calendar that waits on a round trip before showing the change
    // gets tapped twice.
    const previous = days[date];
    setDays((d) => {
      const existing = d[date] ?? [];
      // A slot the purohit is declaring for the first time has no row to update.
      const known = existing.some((s) => s.slotIdx === slotIdx);
      return {
        ...d,
        [date]: known
          ? existing.map((s) => (s.slotIdx === slotIdx ? { ...s, status } : s))
          : [...existing, { slotIdx, status, bookingId: null }],
      };
    });
    try {
      const res = await api<{ updated: number; skipped: number }>(
        '/v1/me/purohit/availability',
        { method: 'PATCH', body: JSON.stringify({ changes: [{ date, slotIdx, status }] }) },
      );
      // The server refuses booked slots. Rolling back is the honest response to
      // "we did not do what you just saw happen".
      if (res.updated === 0) {
        setDays((d) => ({ ...d, [date]: previous ?? [] }));
        setError(
          status === 'closed'
            ? 'That slot is already booked, so it cannot be closed.'
            : 'That slot could not be opened.',
        );
      }
    } catch (e) {
      setDays((d) => ({ ...d, [date]: previous ?? [] }));
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return { days, slotTimes, setSlot, saving, error };
}

/* -------------------------------------------------------------------- admin -- */

export interface Coverage {
  date: string;
  openSlots: number;
  bookedSlots: number;
  blockedSlots: number;
  purohits: number;
  utilisation: number | null;
}

/**
 * How thin supply is on a given day.
 *
 * The console shows bookings and a ledger — both records of what already happened.
 * A Saturday in festival week with four open slots across the city is a day of
 * rejected bookings, and it is only actionable while there is still time to ring
 * purohits and ask them to open more.
 */
export function CoverageDay({ day }: { day: Coverage | undefined }) {
  if (!day) {
    return (
      <p className="muted">
        No verified purohit has opened a calendar on this date.
      </p>
    );
  }

  const sellable = day.openSlots + day.bookedSlots;
  const pct = day.utilisation === null ? null : Math.round(day.utilisation * 100);
  /*
   * Thresholds are operational judgement, not arithmetic: they are the point at
   * which somebody should pick up the phone.
   *
   * Written out rather than composed as `cov-${tone}`. A class name assembled from
   * a fragment cannot be found by grepping the stylesheet for it — not by the dead
   * rule check in css-invariants.test.ts, and not by whoever is trying to work out
   * where a colour comes from at four in the afternoon.
   */
  const tone = day.openSlots === 0 ? 'cov-bad'
    : day.openSlots < 6 ? 'cov-warn'
    : 'cov-ok';

  return (
    <div className={`cov ${tone}`}>
      <dl className="cov-figs">
        <div><dt>Purohits</dt><dd>{day.purohits}</dd></div>
        <div><dt>Open slots</dt><dd>{day.openSlots}</dd></div>
        <div><dt>Booked</dt><dd>{day.bookedSlots}</dd></div>
        <div><dt>Held by travel</dt><dd>{day.blockedSlots}</dd></div>
        <div><dt>Utilisation</dt><dd>{pct === null ? '—' : `${pct}%`}</dd></div>
      </dl>
      <p className="cov-read">
        {day.openSlots === 0
          ? `Nothing sellable on this date — ${sellable} slots, all taken.`
          : day.openSlots < 6
            ? `Thin: ${day.openSlots} slots left across ${day.purohits} purohit${day.purohits === 1 ? '' : 's'}.`
            : `${day.openSlots} slots free across ${day.purohits} purohits.`}
      </p>
    </div>
  );
}
