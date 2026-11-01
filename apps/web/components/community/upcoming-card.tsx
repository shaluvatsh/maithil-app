'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { usePanchangSchool } from '@/lib/panchang-school';

/**
 * What is coming up, for this household's city and almanac.
 *
 * The reason to open the app on a day you are not booking anything — and the one
 * thing here no competitor computes in-house, because it is answered per panjika
 * rather than from a single national calendar. Two households on the same street
 * keeping different almanacs get different answers, and that is the product.
 *
 * Zero user-generated content, so it carries no moderation cost at all. That is why
 * it ships first in the community sequence: a surface that is worth opening daily,
 * before there is any obligation to police what is on it.
 */
interface Item {
  kind: 'festival' | 'observance';
  id: string;
  name: string;
  blurb: string;
  date: string;
  endsOn: string | null;
  ritualSlug: string | null;
}

/** Local midnight, not UTC — "in 2 days" must mean what the reader's calendar says. */
function daysUntil(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d).setHours(0, 0, 0, 0);
  const now = new Date().setHours(0, 0, 0, 0);
  return Math.round((then - now) / 86_400_000);
}

export function UpcomingCard() {
  const { region, locale, t, numerals, date: fmtDate } = useRegion();
  // Which almanac this city actually publishes, rather than the configured
  // default — Kolkata's default is hand-entered and has never been entered.
  const { school } = usePanchangSchool();
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    if (!school) return;
    const today = new Date();
    const from = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');

    let live = true;
    void api<Item[]>(
      `/v1/panchang/upcoming?citySlug=${region.slug}&school=${school}`
      + `&from=${from}&locale=${locale}`,
      { auth: false },
    ).then((res) => { if (live) setItems(res); })
      // A countdown that fails is not worth an error message on a community feed;
      // the card simply does not appear and the page is unaffected.
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [region.slug, school, locale]);

  if (!items || items.length === 0) return null;

  const [next, ...rest] = items;
  const away = daysUntil(next!.date);

  return (
    <section className="up-card" aria-label={t('community.upcoming')}>
      <div className="up-lead">
        <span className={`up-when${away <= 1 ? ' soon' : ''}`}>
          {away <= 0 ? t('community.today')
            : away === 1 ? t('community.tomorrow')
            : t('community.inDays', { count: numerals(away) })}
        </span>
        <h2 className="up-name">{next!.name}</h2>
        <p className="up-blurb muted">{next!.blurb}</p>
        <p className="up-date muted">
          {fmtDate(next!.date)}
          {next!.endsOn && <> – {fmtDate(next!.endsOn)}</>}
          {/* Whose almanac this is. Two households on one street may differ, so an
              unattributed date is a date somebody will act on and regret. */}
          {' · '}{region.panjikas.find((p) => p.id === school)?.native ?? school}
        </p>
        {next!.ritualSlug && (
          <Link href={`/book?ritual=${next!.ritualSlug}`} className="btn sm">
            {t('community.bookFor', { festival: next!.name })}
          </Link>
        )}
      </div>

      {rest.length > 0 && (
        <ul className="up-rest">
          {rest.slice(0, 4).map((i) => (
            <li key={`${i.id}-${i.date}`}>
              <span className="up-rest-name">{i.name}</span>
              <span className="muted">
                {t('community.inDays', { count: numerals(daysUntil(i.date)) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
