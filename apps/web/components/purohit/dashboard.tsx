'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import type { MessageKey } from '@themaithil/region';

/**
 * The purohit's dashboard.
 *
 * NOT A LEADERBOARD. Since ADR 0012 the platform allocates work, so a purohit cannot
 * win a ranking against peers they never competed with — and publishing one would
 * tell whoever is top that they are winning and tell everyone in eighth place to
 * leave, accelerating the concentration ADR 0012 warned about. The API never sends
 * another purohit's name or number; comparison is to a suppressed-below-five cohort
 * median, which carries the same motivation and cannot be gamed.
 *
 * DESIGNED FOR THE ACTUAL READER: 30-65, mid-range Android, often outdoors between
 * jobs, possibly reading Bengali or Hindi. So one vertical column and no second
 * navigation layer; three numbers above the fold at most; every number paired with a
 * sentence, because "78% acceptance" means nothing and "you turned down 3 of 14"
 * means something.
 *
 * Section order is by what changes behaviour, not by what is easy to compute:
 * what do I do today, what am I owed, what is quietly costing me work, and why is my
 * work what it is.
 */

interface Attention { code: string; severity: 'blocking' | 'advice' }

interface Rung {
  code: string;
  earned: boolean;
  /** Null on a yes/no rung: "0 of 1" reads as a score rather than as a task. */
  progress: { have: number; need: number } | null;
}

interface DemandArea {
  pincode: string;
  /** Null when the total would expose too few other households. */
  bookings: number | null;
  /** Their own, always exact — their work is their own data. */
  yours: number;
  suppressed: boolean;
  distanceKm: number | null;
  /** Null when we never measured the distance, so coverage is unknown. */
  covered: boolean | null;
}

interface Dashboard {
  standing: {
    rating: number | null; ratingCount: number;
    acceptanceRate: number | null; experienceYears: number;
    kycStatus: string; newSupplyBoostRemaining: number;
  };
  money: {
    grossPaise: number; duesPaise: number; tdsCarryPaise: number;
    alreadyPaidPaise: number; netPayablePaise: number;
    cashLimitPaise: number; cashHeadroomPaise: number;
  };
  work: {
    today: number; upcoming: number; awaitingAccept: number;
    completedThisPeriod: number; droppedThisPeriod: number;
    periodDays: number; horizonDays: number;
  };
  allocation: {
    periodDays: number; offered: number; nearMiss: number; declinedAway: number;
    lastScored: {
      at: string;
      components: Record<string, unknown>;
      weights: Record<string, unknown>;
    } | null;
  };
  cohort: {
    size: number; suppressed: boolean;
    medianAcceptance: number | null; medianRating: number | null;
  };
  demand: {
    windowDays: number;
    serviceRadiusKm: number | null;
    areas: DemandArea[];
    uncovered: DemandArea[];
  };
  attention: Attention[];
  ladder: Rung[];
}

/**
 * Where each problem sends them — a real DESTINATION, not a bare page.
 *
 * Two generations of this bug, both now fixed. The first pointed everything at
 * `/purohit/setup`, a four-step wizard, so "Fix this" under "no bank account linked"
 * dropped a purohit on step one asking which city they work in. The second, closer
 * fix pointed at panel fragments on that same page — `#payout`, `#calendar` — but
 * `/purohit#earnings` named an id that was never on the page (confirmed live: the
 * Earnings heading had no `id` at all), so that link navigated and scrolled nowhere.
 * `#calendar` pointed at the slot-opening action, which was never a control for
 * auto-accept either.
 *
 * Payout, rates and the dashboard itself are now real routes under the profile menu,
 * and auto-accept has an actual toggle (`QuickActions`, on `/purohit`) for the first
 * time — so every one of these finally lands on something that exists.
 */
const FIX_ROUTE: Record<string, string> = {
  kyc_incomplete: '/purohit/setup',
  payout_account_missing: '/purohit/payouts',
  cash_jobs_paused: '/purohit/payouts',
  cash_headroom_low: '/purohit/payouts',
  auto_accept_off: '/purohit',
  no_chanting_sample: '/purohit/setup',
};

/**
 * And the same for a ladder rung: a rung is a thing to do, so it should be one tap
 * from the thing that does it. A rung with no route stays plain text rather than
 * pretending to be a link.
 */
const RUNG_ROUTE: Record<string, string> = {
  photo: '/purohit/setup',
  chanting_sample: '/purohit/setup',
  payout_linked: '/purohit/payouts',
  qualification: '/purohit/setup',
  cash_enabled: '/purohit/payouts',
  community_voice: '/community',
};

export function PurohitDashboard() {
  const { t, money, numerals } = useRegion();
  const [d, setD] = useState<Dashboard | null>(null);

  useEffect(() => {
    let live = true;
    void api<Dashboard>('/v1/me/purohit/dashboard')
      .then((res) => { if (live) setD(res); })
      // A dashboard that fails must not take the jobs list with it: the purohit came
      // here to see today's work, and that is rendered below this component.
      .catch(() => { if (live) setD(null); });
    return () => { live = false; };
  }, []);

  if (!d) return null;

  const blocking = d.attention.filter((a) => a.severity === 'blocking');
  const advice = d.attention.filter((a) => a.severity === 'advice');

  return (
    <div className="pd">
      {/*
        * TODAY. The only question that matters before nine in the morning, and the
        * reason this sits above everything else on the screen.
        */}
      <section className="pd-today">
        <h2 className="pd-h">{t('dash.today')}</h2>
        {d.work.today === 0
          ? <p className="pd-lead muted">{t('dash.todayNone')}</p>
          : <p className="pd-lead">{t('dash.todayCount', { count: numerals(d.work.today) })}</p>}

        <p className="pd-sub muted">
          {t('dash.upcoming', { count: numerals(d.work.upcoming) })}
          {d.work.completedThisPeriod > 0 && (
            <> · {t('dash.completed', {
              count: numerals(d.work.completedThisPeriod),
              days: numerals(d.work.periodDays),
            })}</>
          )}
        </p>

        {/* A request with a deadline outranks everything else on the page. */}
        {d.work.awaitingAccept > 0 && (
          <p className="pd-urgent">
            {t('dash.awaiting', { count: numerals(d.work.awaitingAccept) })}
            {' '}<a href="#requests" className="btn sm">{t('dash.answerNow')}</a>
          </p>
        )}
      </section>

      {/*
        * Blocking problems before money, because a blocked purohit has no money to
        * look at and needs to know why rather than discovering it on payout day.
        */}
      {blocking.length > 0 && (
        <section className="pd-attn blocking">
          <h2 className="pd-h">{t('dash.attention')}</h2>
          <ul>{blocking.map((a) => <AttentionRow key={a.code} a={a} />)}</ul>
        </section>
      )}

      <section className="pd-money">
        <h2 className="pd-h">{t('dash.money')}</h2>
        <p className="pd-lead">{money(d.money.netPayablePaise)}</p>
        <p className="pd-sub muted">{t('dash.payable')}</p>

        <dl className="pd-kv">
          <div><dt>{t('dash.gross')}</dt><dd>{money(d.money.grossPaise)}</dd></div>
          {/*
            * Shown even at zero. Cash jobs mean the purohit holds the devotee's money
            * and owes us commission, so gross and net differ by an amount they never
            * received — hiding the line turns a legible deduction into an
            * unexplained shortfall, which is what a support call is made of.
            */}
          <div><dt>{t('dash.dues')}</dt><dd>{money(d.money.duesPaise)}</dd></div>
          {d.money.tdsCarryPaise > 0 && (
            <div><dt>{t('dash.tds')}</dt><dd>{money(d.money.tdsCarryPaise)}</dd></div>
          )}
        </dl>

        {d.money.cashLimitPaise > 0 && (
          <p className="pd-sub muted">
            {t('dash.cashHeadroom', { amount: money(d.money.cashHeadroomPaise) })}
          </p>
        )}
      </section>

      {/*
        * WHY THEY ARE GETTING WORK. ADR 0012 required this — "the weights need to be
        * observable" — and until `match_decisions` existed it could not be answered.
        * No competitor in this category tells supply anything.
        */}
      <section className="pd-alloc">
        <h2 className="pd-h">{t('dash.allocation')}</h2>
        {d.allocation.offered + d.allocation.nearMiss + d.allocation.declinedAway === 0
          ? <p className="muted">{t('dash.allocationEmpty')}</p>
          : (
            <>
              <ul className="pd-tally">
                <li>
                  <span className="pd-n">{numerals(d.allocation.offered)}</span>
                  <span className="muted">{t('dash.offered')}</span>
                </li>
                <li>
                  <span className="pd-n">{numerals(d.allocation.nearMiss)}</span>
                  <span className="muted">{t('dash.nearMiss')}</span>
                </li>
                <li>
                  <span className="pd-n">{numerals(d.allocation.declinedAway)}</span>
                  <span className="muted">{t('dash.declinedAway')}</span>
                </li>
              </ul>
              {/* Said out loud, because the absence of a leaderboard is a promise. */}
              <p className="pd-note muted">{t('dash.allocationNote')}</p>
            </>
          )}

        {d.standing.newSupplyBoostRemaining > 0 && (
          // Finite, and they should know: a purohit who thinks this rate of work is
          // normal concludes the platform turned against them when it expires.
          <p className="pd-boost">
            {t('dash.newBoost', { count: numerals(d.standing.newSupplyBoostRemaining) })}
          </p>
        )}
      </section>

      {/*
        * WHERE THE WORK IS. The most actionable section: it converts into two
        * decisions a purohit can make this afternoon — widen the radius, or open a
        * slot. Below allocation because it only makes sense once they know how work
        * reaches them at all.
        */}
      <section className="pd-demand">
        <h2 className="pd-h">{t('dash.demand')}</h2>
        {d.demand.areas.length === 0
          ? <p className="muted">{t('dash.demandEmpty')}</p>
          : (
            <>
              <p className="pd-sub muted">
                {t('dash.demandWindow', { days: numerals(d.demand.windowDays) })}
              </p>

              {d.demand.uncovered.length > 0 && (
                <p className="pd-urgent">
                  {t('dash.uncoveredLead', { count: numerals(d.demand.uncovered.length) })}
                  {' '}
                  <Link href="/purohit/setup" className="btn sm">{t('dash.widenRadius')}</Link>
                </p>
              )}

              <ul className="pd-areas">
                {d.demand.areas.slice(0, 6).map((a) => (
                  <li key={a.pincode} className={a.covered === false ? 'pd-area far' : 'pd-area'}>
                    <span className="pd-pin">{a.pincode}</span>
                    <span className="pd-count">
                      {/*
                        * A withheld total says so rather than showing nothing: a blank
                        * cell reads as a bug, and the reason is worth stating once.
                        */}
                      {a.bookings === null
                        ? <em className="muted" title={t('dash.withheldWhy')}>
                            {t('dash.withheld')}
                          </em>
                        : numerals(a.bookings)}
                      {a.yours > 0 && a.bookings !== a.yours && (
                        <span className="muted"> · {t('dash.yoursOnly', {
                          count: numerals(a.yours),
                        })}</span>
                      )}
                    </span>
                    <span className="pd-where muted">
                      {a.covered === null ? t('dash.locationUnknown')
                        : a.covered ? t('dash.youCover')
                        : t('dash.outsideRadius', {
                          km: numerals(a.distanceKm ?? 0),
                          radius: numerals(d.demand.serviceRadiusKm ?? 0),
                        })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
      </section>

      <section className="pd-standing">
        <h2 className="pd-h">{t('dash.standing')}</h2>
        <dl className="pd-kv">
          <div>
            <dt>{t('dash.rating')}</dt>
            <dd>
              {d.standing.rating === null
                ? <span className="muted">{t('dash.noRating')}</span>
                : <>{numerals(d.standing.rating)} ({numerals(d.standing.ratingCount)})</>}
            </dd>
          </div>
          {d.standing.acceptanceRate !== null && (
            <div>
              <dt>{t('dash.acceptance')}</dt>
              <dd>{numerals(Math.round(d.standing.acceptanceRate * 100))}%</dd>
            </div>
          )}
        </dl>

        {/*
          * The cohort, or an explanation of its absence.
          *
          * Suppressed below five peers because with four a median names one of them.
          * Saying so is better than rendering nothing, which reads as a broken panel.
          */}
        <p className="pd-sub muted">
          {d.cohort.suppressed
            ? t('dash.cohortSmall')
            : d.cohort.medianAcceptance !== null
              ? t('dash.cohortMedian', {
                value: `${numerals(Math.round(d.cohort.medianAcceptance * 100))}%`,
              })
              : ''}
        </p>
      </section>

      {/*
        * THE LADDER, last on the page.
        *
        * Correctly last: it is the long-horizon section, read once a week rather than
        * before nine in the morning. Everything above it is about today.
        *
        * Every rung states what it needs. That is the rule, not decoration — an
        * unexplained badge is a mystery to the purohit who has it and an insult to the
        * one who does not, and each of these is something they can act on today.
        */}
      <section className="pd-ladder">
        <h2 className="pd-h">{t('dash.ladder')}</h2>
        <p className="pd-sub muted">{t('dash.ladderBlurb')}</p>

        <ul className="pd-rungs">
          {d.ladder.map((r) => {
            const name = t(`dash.rung.${r.code}` as MessageKey);
            const why = t(`dash.rungWhy.${r.code}` as MessageKey);
            // An untranslated rung renders nothing rather than its code: a purohit
            // must never be shown `samagri_accurate`.
            if (name === `dash.rung.${r.code}`) return null;

            return (
              <li key={r.code} className={r.earned ? 'pd-rung on' : 'pd-rung'}>
                <span className="pd-rung-mark" aria-hidden>{r.earned ? '✓' : '○'}</span>
                <span className="pd-rung-body">
                  {/* An unearned rung with somewhere to go is a link; an earned one,
                      or one with no route, is not — a link that leads nowhere is
                      worse than plain text. */}
                  {!r.earned && RUNG_ROUTE[r.code]
                    ? (
                      <Link href={RUNG_ROUTE[r.code]!} className="pd-rung-name pd-rung-link">
                        {name}
                      </Link>
                    )
                    : <span className="pd-rung-name">{name}</span>}
                  {/* The criterion, always — including on an earned rung, so the
                      purohit knows what it was awarded for. */}
                  {why !== `dash.rungWhy.${r.code}` && (
                    <span className="pd-rung-why muted">{why}</span>
                  )}
                </span>
                <span className="pd-rung-state muted">
                  {r.earned
                    ? t('dash.rungDone')
                    : r.progress
                      ? t('dash.rungProgress', {
                        have: numerals(r.progress.have), need: numerals(r.progress.need),
                      })
                      : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {advice.length > 0 && (
        <section className="pd-attn">
          <ul>{advice.map((a) => <AttentionRow key={a.code} a={a} />)}</ul>
        </section>
      )}
    </div>
  );
}

/**
 * One thing worth doing, with the route to do it.
 *
 * The API sends a CODE, not a sentence, so this is where it becomes language. An
 * unknown code renders nothing rather than the raw code: a purohit should never be
 * shown `cash_headroom_low`, and a new code shipped before its translation is a
 * missing row, not a leaked identifier.
 */
function AttentionRow({ a }: { a: Attention }) {
  const { t } = useRegion();
  const key = `dash.attn.${a.code}` as MessageKey;
  const copy = t(key);
  if (copy === key) return null;

  return (
    <li className={a.severity === 'blocking' ? 'pd-attn-row bad' : 'pd-attn-row'}>
      <span>{copy}</span>
      {FIX_ROUTE[a.code] && (
        <Link href={FIX_ROUTE[a.code]!} className="btn outline sm">{t('dash.fix')}</Link>
      )}
    </li>
  );
}
