'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/modal';

/**
 * The membership offer.
 *
 * Three versions, each fixing the last one's mistake:
 *
 *  1. Eight literals typed into JSX — "18% OFF", "save up to ₹2,099", "145 days
 *     left" — none of them backed by a row anyone could buy from.
 *  2. Real numbers, wrong layout: a two-column split that read as two unrelated
 *     cards on a wide screen and collapsed into a cramped stack on a narrow one.
 *  3. One card, but the whole plan spelled out on the home page — four benefits,
 *     six priced rituals and a three-line calculation, sitting between the
 *     catalogue and the footer for the overwhelming majority of visitors who came
 *     to book a puja and have no interest in a subscription.
 *
 * This is the fourth: on the page, only what someone needs to decide whether to
 * look further — what it is, what it costs, the single strongest reason. Everything
 * else is one click away, where it has room to be read properly and where the
 * person reading it has chosen to.
 */
export interface Offer {
  slug: string;
  name: string;
  tagline: string;
  pricePaise: number;
  durationDays: number;
  discountBps: number;
  benefits: string[];
  offerEndsOn: string | null;
  /** Whether money can actually change hands for it yet. */
  purchasable: boolean;
  daysLeft: number | null;
  bundle: {
    rituals: Array<{ slug: string; name: string; pricePaise: number }>;
    listPaise: number;
    memberPaise: number;
    savingPaise: number;
  } | null;
  netSavingPaise: number | null;
}

/**
 * Is this actually a plan?
 *
 * A `null` check alone is not enough: anything truthy reaching this component and
 * failing to have `benefits` took the entire home page down, because an unguarded
 * `.map` in a render throws and React unmounts the tree. A promotional card is the
 * least important thing on the page and must not be able to remove the catalogue.
 */
export function isOffer(v: unknown): v is Offer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<Offer>;
  return typeof o.name === 'string'
    && typeof o.pricePaise === 'number'
    && typeof o.discountBps === 'number'
    && Array.isArray(o.benefits)
    && typeof o.purchasable === 'boolean';
}

export function OfferCard({
  offer, money,
}: {
  offer: Offer | null;
  money: (paise: number) => string;
}) {
  const [open, setOpen] = useState(false);
  if (!isOffer(offer)) return null;

  const pct = Math.round(offer.discountBps / 100);
  const months = Math.round(offer.durationDays / 30);
  const period = months >= 12 ? 'a year' : `${months} months`;
  const worthIt = offer.netSavingPaise !== null && offer.netSavingPaise > 0;

  /**
   * The purchase action, in both places.
   *
   * Rendered on the card AND in the dialog, because a reader who opens the detail
   * to be convinced should not have to close it again to act — a dialog whose only
   * exit is "Close" makes the reader undo their own interest.
   *
   * `purchasable` is false until checkout and entitlement exist. Nothing charges
   * for the membership and nothing applies the discount at booking time, so a
   * working Join would take real money for a benefit the pricing engine never
   * grants.
   */
  const buy = (variant: 'solid' | 'block') => (offer.purchasable ? (
    <Link href={`/book?plan=${offer.slug}`} className={variant === 'block' ? 'btn block' : 'btn'}>
      Join for {money(offer.pricePaise)}
    </Link>
  ) : (
    <Link href="/contact?about=membership"
          className={variant === 'block' ? 'btn outline block' : 'btn outline'}>
      Tell me when it opens
    </Link>
  ));

  return (
    <>
      <section className="plan" aria-labelledby="plan-name">
        <div className="plan-main">
          <span className="plan-kicker">Membership</span>
          <h2 id="plan-name">{offer.name}</h2>

          {/*
            One reason, not four. The strongest thing a member gets is the standing
            discount; the rest is detail for somebody already interested, and
            printing all of it here made the section a wall between the catalogue
            and the footer.
          */}
          <p className="plan-hook">
            {pct}% off the purohit&apos;s dakshina on every booking for {period}
            {worthIt && offer.bundle
              ? ` — about ${money(offer.netSavingPaise!)} back over a festival season.`
              : '.'}
          </p>

          <button type="button" className="plan-more" onClick={() => setOpen(true)}
                  aria-haspopup="dialog">
            See what&apos;s included ›
          </button>
        </div>

        <div className="plan-buy">
          <span className="pb-amt">{money(offer.pricePaise)}</span>
          <span className="pb-per">for {period}</span>
          {offer.daysLeft !== null && offer.daysLeft <= 60 && (
            <span className="pb-ends">
              {offer.daysLeft === 0 ? 'Last day to join' : `${offer.daysLeft} days left`}
            </span>
          )}
          {buy('block')}
        </div>
      </section>

      {open && (
        <Modal title={offer.name} onClose={() => setOpen(false)} labelledBy="plan-modal-h">
          <p className="muted plan-sub">{offer.tagline}</p>

          <h4 className="plan-h">What you get</h4>
          <ul className="plan-list">
            {offer.benefits.map((b) => <li key={b}>{b}</li>)}
          </ul>

          {offer.bundle && (
            <>
              <h4 className="plan-h">{pct}% off these, and everything else</h4>
              {/*
                The rituals actually priced in this city, read from the same
                `ritual_city_prices` the checkout charges from — so the list and the
                arithmetic below cannot drift from what a member is billed.
              */}
              <ul className="plan-incl">
                {offer.bundle.rituals.map((r) => (
                  <li key={r.slug}>
                    <Link href={`/pooja/${r.slug}`}>{r.name}</Link>
                    <span className="pi-price">{money(r.pricePaise)}</span>
                  </li>
                ))}
              </ul>

              <dl className="plan-math">
                <div>
                  <dt>Booked separately</dt>
                  <dd className="strike">{money(offer.bundle.listPaise)}</dd>
                </div>
                <div>
                  <dt>Member price</dt>
                  <dd>{money(offer.bundle.memberPaise)}</dd>
                </div>
                {/*
                  Net of the membership fee. Advertising the gross discount while
                  charging separately for the plan is the trick this line refuses,
                  and when the number is negative it says so instead of hiding it.
                */}
                <div className={worthIt ? 'net good' : 'net'}>
                  <dt>{worthIt ? 'You keep' : 'After the membership fee'}</dt>
                  <dd>
                    {offer.netSavingPaise !== null
                      ? `${offer.netSavingPaise < 0 ? '−' : ''}${money(Math.abs(offer.netSavingPaise))}`
                      : '—'}
                  </dd>
                </div>
              </dl>
            </>
          )}

          <div className="plan-foot">
            {buy('solid')}
            <p className="plan-terms muted">
              {offer.purchasable
                ? `${pct}% applies to the purohit's dakshina on every booking for ${period}.`
                : `Not on sale yet — ${pct}% off the purohit's dakshina for ${period} when it opens.`}
              {' '}Samagri is charged at cost either way.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
