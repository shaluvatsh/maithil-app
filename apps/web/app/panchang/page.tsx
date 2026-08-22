'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { dayList } from '@/lib/format';
import { usePanchangSchool } from '@/lib/panchang-school';
import { PanchangCalendar } from '@/components/panchang-calendar';
import { AuspiciousDates } from '@/components/home/panchang-sections';
import { auth } from '@/lib/api';
import { roleOf, type Role } from '@/lib/nav-model';
import {
  PurohitDay, CoverageDay, usePurohitCalendar, type Coverage,
} from '@/components/panchang/role-views';
import { WeeklyPatternEditor } from '@/components/purohit/weekly-pattern';

interface Window_ { startsAt: string; endsAt: string }
interface Day {
  date: string; school: string; bengaliDate: string | null;
  tithiAtSunrise: string; nakshatraAtSunrise: string;
  sunrise: string; sunset: string;
  abhijit: Window_ | null; rahuKaal: Window_ | null;
  auspiciousForRitualIds: string[];
  schoolsDisagree: boolean;
}

export default function PanchangPage() {
  const { region, time, date: fmtDate } = useRegion();
  /**
   * The page used to open on `region.defaultPanjika`. In Kolkata that is Gupta
   * Press, which under ADR 0003 is hand-entered and never has been, so this page
   * greeted every visitor with "this almanac is not published yet" and no
   * calendar. The school is now resolved against what the API actually holds.
   */
  const { school, schools, substituted, choose } = usePanchangSchool();
  const [days, setDays] = useState<Day[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  /**
   * The almanac is the same for everyone; the question asked of it is not.
   *
   * Starts as `guest` on server and client alike — reading `auth` during render is
   * a hydration mismatch — so the page opens as the public almanac and grows the
   * role's own controls once the token has been read.
   */
  const [role, setRole] = useState<Role>('guest');
  useEffect(() => { setRole(roleOf(Boolean(auth.token), auth.role)); }, []);

  const window31 = dayList(31, 0);
  const from = window31[0]!;
  const to = window31.at(-1)!;

  const purohit = usePurohitCalendar(from, to, role === 'pandit');

  /**
   * Ritual names, so the day panel can say WHICH rituals a date is good for.
   * The panchang endpoint returns ids; a devotee cannot act on an id.
   */
  const [ritualsById, setRitualsById] = useState<Map<string, { slug: string; name: string }>>(new Map());
  useEffect(() => {
    api<Array<{ id: string; slug: string; name: string }>>(
      `/v1/rituals?citySlug=${region.slug}&locale=en`, { auth: false },
    )
      .then((list) => setRitualsById(new Map(list.map((r) => [r.id, { slug: r.slug, name: r.name }]))))
      .catch(() => setRitualsById(new Map()));
  }, [region.slug]);

  const [coverage, setCoverage] = useState<Record<string, Coverage>>({});
  useEffect(() => {
    if (role !== 'admin') return;
    api<Coverage[]>(`/v1/admin/coverage?citySlug=${region.slug}&from=${from}&to=${to}`)
      .then((list) => setCoverage(Object.fromEntries(list.map((c) => [c.date, c]))))
      .catch(() => setCoverage({}));
  }, [role, region.slug, from, to]);

  useEffect(() => {
    if (!school) return;
    setLoading(true); setErr(null);
    // From today, not tomorrow. This page is for reading, not booking.
    api<Day[]>(
      `/v1/panchang?citySlug=${region.slug}&from=${from}&to=${to}&school=${school}&locale=en`,
      { auth: false },
    ).then(setDays).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
  }, [school, region.slug]);

  // Falls back to the region config so the chooser still renders while the
  // published-schools lookup is in flight.
  const offered = schools.length > 0 ? schools : region.panjikas.map((p) => ({
    ...p, published: true, from: null, to: null,
  }));
  const active = offered.find((p) => p.id === school);

  return (
    <div className="wrap" style={{ padding: '34px 20px 80px' }}>
      <span className="kicker-pill">
        {role === 'pandit' ? 'Your working calendar'
          : role === 'admin' ? 'Supply calendar' : 'Spiritual Calendar'}
      </span>
      <h1 style={{ fontSize: '1.9rem' }}>Panchang · {region.name.en}</h1>
      <p className="sub">
        {role === 'pandit'
          ? 'Tithi and muhurat, with your own slots on every date — open or close them here.'
          : role === 'admin'
            ? 'Tithi and muhurat, with how much verified supply is free on each date.'
            : 'Tithi, nakshatra and the day\u2019s auspicious and inauspicious windows, computed for your city.'}
      </p>

      <div className="card" style={{ marginBottom: 22 }}>
        <label style={{ textTransform: 'none', letterSpacing: 0, fontSize: '.9rem' }}>
          Which panchang does your family follow?
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          {offered.map((p) => (
            <button key={p.id} className={school === p.id ? '' : 'outline'}
                    onClick={() => choose(p.id)} style={{ borderRadius: 999 }}>
              {p.english}
              <span style={{ opacity: .65, marginLeft: 8, fontWeight: 400 }}>{p.native}</span>
              {/* Marked rather than hidden: a family looking for their own almanac
                  needs to see that it exists and is simply not in yet. */}
              {!p.published && <span className="pill-warn">not in yet</span>}
            </button>
          ))}
        </div>
        {active && <p className="muted" style={{ fontSize: '.9rem', margin: '12px 0 0' }}>{active.note}</p>}

        {substituted && (
          <p className="notice warn" style={{ margin: '12px 0 0', fontSize: '.9rem' }}>
            Your family follows <strong>{substituted.english}</strong>, which has not
            been transcribed for this year yet. Showing{' '}
            <strong>{active?.english ?? 'the computed almanac'}</strong> instead —
            the two differ on some tithis, so check with your purohit for a wedding
            or upanayan date.
          </p>
        )}
        {region.panjikas.length > 1 && (
          <p className="muted" style={{ fontSize: '.85rem', margin: '8px 0 0' }}>
            These almanacs do not always agree. Where they differ we mark the day rather
            than choosing for you.
          </p>
        )}
      </div>

      {err && <div className="notice err">{err}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && days.length === 0 && !err && (
        <div className="card">
          {/* This told the user to run `pnpm db:seed:dev`. A developer instruction
              in a devotee-facing empty state. */}
          <strong>This almanac is not published yet.</strong>
          <p className="muted" style={{ fontSize: '.92rem', marginBottom: 0 }}>
            Gupta Press and Mithila Panchang apply their own traditional
            corrections, so they cannot be computed — a purohit enters them by hand
            once a year, and this year&apos;s is not in yet. Bisuddha Siddhanta is
            computed from observed positions and is available above.
          </p>
        </div>
      )}

      {/*
        The repeating shape first, the exceptions below it.

        A purohit declaring "I work Tuesday and Thursday mornings" through the
        per-date calendar needed 120 taps. State it once here; override single days
        on the calendar underneath.
      */}
      {role === 'pandit' && <WeeklyPatternEditor slotTimes={purohit.slotTimes} />}

      {/* Overview first: a month is a shape, not a list. The table below stays as
          the detail view for anyone comparing sunrise and window times. */}
      <PanchangCalendar
        days={days}
        time={time}
        ritualsById={ritualsById}
        badgeFor={
          role === 'pandit'
            ? (d) => {
              const slots = purohit.days[d];
              const booked = (slots ?? []).filter((s) => s.status === 'booked').length;
              const open = (slots ?? []).filter((s) => s.status === 'open').length;
              if (booked > 0) return { text: `${booked} booked`, tone: 'warn' as const };
              if (open > 0) return { text: `${open} free`, tone: 'ok' as const };
              // Not "0 free" — nothing has been declared either way, and a red
              // zero on every future date reads as a fault rather than a choice.
              return { text: 'not set', tone: 'bad' as const };
            }
            : role === 'admin'
              ? (d) => {
                const c = coverage[d];
                if (!c) return { text: 'none', tone: 'bad' as const };
                return {
                  text: `${c.openSlots} free`,
                  tone: c.openSlots === 0 ? 'bad' as const
                    : c.openSlots < 6 ? 'warn' as const : 'ok' as const,
                };
              }
              : undefined
        }
        cta={
          role === 'pandit' || role === 'admin'
            // Neither of them is buying a puja; a "Book a pooja" button on an
            // operator's supply screen is an invitation to a support ticket.
            ? null
            : undefined
        }
      >
        {(d) => (
          role === 'pandit' ? (
            <PurohitDay
              date={d}
              slots={purohit.days[d]}
              slotTimes={purohit.slotTimes}
              onChange={(idx, status) => void purohit.setSlot(d, idx, status)}
              saving={purohit.saving}
              error={purohit.error}
            />
          ) : role === 'admin' ? (
            <CoverageDay day={coverage[d]} />
          ) : null
        )}
      </PanchangCalendar>

      {/*
        Moved here from the home page.

        Auspiciousness is per ritual, and on the home page this was shown to
        someone who had not chosen a service yet — a shortlist of good days with
        nothing to be good for. Here it sits under a calendar that has already
        established what a tithi is, and it is the natural next question after
        "what is today": which days this month are worth acting on.
      */}
      {role !== 'pandit' && role !== 'admin' && (
        <AuspiciousDates days={days.filter((d) => d.auspiciousForRitualIds.length > 0)} />
      )}

      {days.length > 0 && (
        <details className="cal-details">
          <summary>All timings for these {days.length} days</summary>
          <div className="table-wrap"><table>
          <thead><tr>
            <th>Date</th><th>Local date</th><th>Tithi</th><th>Nakshatra</th>
            <th>Sunrise</th><th>Abhijit · best</th><th>Rahu Kaal · avoid</th><th />
          </tr></thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td>{fmtDate(d.date)}</td>
                <td className="muted">{d.bengaliDate ?? '—'}</td>
                <td>{d.tithiAtSunrise}</td>
                <td>{d.nakshatraAtSunrise}</td>
                <td className="muted">{time(d.sunrise)}</td>
                <td>{d.abhijit
                  ? <span className="tag auspicious">{time(d.abhijit.startsAt)}–{time(d.abhijit.endsAt)}</span>
                  : '—'}</td>
                <td>{d.rahuKaal
                  ? <span className="tag avoid">{time(d.rahuKaal.startsAt)}–{time(d.rahuKaal.endsAt)}</span>
                  : '—'}</td>
                <td>
                  {d.auspiciousForRitualIds.length > 0 && <span className="tag auspicious">Auspicious</span>}
                  {d.schoolsDisagree && <span className="tag avoid">Almanacs differ</span>}
                </td>
              </tr>
            ))}
          </tbody>
          </table></div>
        </details>
      )}

      <p className="muted" style={{ fontSize: '.82rem', marginTop: 18 }}>
        Computed from astronomical positions with the Lahiri ayanamsa. Boundaries are
        accurate to within tens of minutes — for a wedding lagna, confirm with your pandit.
      </p>
    </div>
  );
}
