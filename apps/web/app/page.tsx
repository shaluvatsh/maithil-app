'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { dayList } from '@/lib/format';
import { HeroSearch } from '@/components/home/hero-search';
import { ServiceCard } from '@/components/home/service-card';
import { ServiceRail } from '@/components/home/service-rail';
import { COLLECTIONS, collectionPreview } from '@/lib/collections';
import { getCategory, emojiFor, aliasesFor, RITUAL_CATEGORIES } from '@themaithil/region';
import { CategoryCardSkeletons } from '@/components/skeletons';
import { PanchangCard, type PanchangDay } from '@/components/home/panchang-sections';
import { usePanchangSchool } from '@/lib/panchang-school';
import { OfferCard, isOffer, type Offer } from '@/components/home/offer-card';
import { Anniversaries } from '@/components/home/anniversaries';

interface Ritual {
  id: string; slug: string; name: string; shortDescription: string;
  durationMin: number; bomTotalPaise: number; category: string;
  deliveryMode: 'at_home' | 'virtual';
  priceBand: { minPaise: number; maxPaise: number; defaultPaise: number };
}

interface Category {
  id: string; en: string; blurb: string; emoji: string; tint: string; count: number;
}

/** Real counts, from `/v1/stats`. Every one of these is a `count(*)`. */
interface Stats {
  verifiedPandits: number; rituals: number; cities: number; familiesServed: number;
}


/*
 * There was a `seeded()` helper here — a hash of the ritual's slug mapped into
 * 4.5–4.9 — and every card rendered its output as a star rating. The "Most
 * requested" rail also printed `seeded(slug, 120, 340)` as a review count, so
 * cards read "⭐ 4.7 · 287 reviews" for services nobody has ever booked or
 * reviewed. The reviews table is empty; the API returns nothing to average.
 *
 * A fabricated price is corrected at checkout — the devotee finds out. A
 * fabricated rating is never corrected, and inventing social proof is the one
 * thing a marketplace does not recover from being caught doing. Cards now show
 * what is true about a ritual: how long it takes and where it happens.
 */

export default function Home() {
  const { region, money, time, chosen } = useRegion();
  const [rituals, setRituals] = useState<Ritual[]>([]);
  /*
   * An empty array cannot tell you whether the catalogue is empty or merely late,
   * and the rails were reading it as the former. Every section on this page renders
   * from a client fetch, so treating "not yet" as "none" collapsed the whole
   * document to the hero and the footer for the first moment of every load — which
   * is what pulled the footer up under the hero, and what made a refresh from
   * halfway down land at the bottom. See components/skeletons.tsx.
   */
  const [ritualsPending, setRitualsPending] = useState(true);
  const [catsPending, setCatsPending] = useState(true);
  const [today, setToday] = useState<PanchangDay | null>(null);
  const [month, setMonth] = useState<PanchangDay[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [catError, setCatError] = useState<string | null>(null);
  const { school, loading: schoolLoading } = usePanchangSchool();
  const [panchangPending, setPanchangPending] = useState(true);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    setRitualsPending(true);
    api<Ritual[]>(`/v1/rituals?citySlug=${region.slug}&locale=en`, { auth: false })
      .then(setRituals).catch(() => setRituals([]))
      .finally(() => setRitualsPending(false));

    // Counts come from the API so a tile never advertises an empty section.
    setCatError(null); setCatsPending(true);
    api<Category[]>(`/v1/categories?citySlug=${region.slug}`, { auth: false })
      .then((list) => {
        setCategories(list);
        // Rendering nothing at all is how a broken endpoint looked like a design
        // choice. An empty catalogue is a fault and must say so.
        if (list.length === 0) setCatError('No service categories were returned.');
      })
      .catch((e) => { setCategories([]); setCatError((e as Error).message); })
      .finally(() => setCatsPending(false));

    /*
     * Null is a real answer: no live plan means no offer section at all, rather
     * than the eight hardcoded numbers that used to stand in for one.
     *
     * But `.catch(() => setOffer(null))` on its own is how a feature disappears
     * without leaving a trace — a 500, a missing column and "no plan today" all
     * render as the same nothing. That is precisely how the panchang stayed
     * invisible in twelve cities. The failure is now recorded separately from the
     * empty case, and said out loud in development.
     */
    setOfferError(null);
    api<unknown>(`/v1/offers/current?citySlug=${region.slug}&locale=en`, { auth: false })
      .then((o) => setOffer(isOffer(o) ? o : null))
      .catch((e) => { setOffer(null); setOfferError((e as Error).message); });

    api<Stats>('/v1/stats', { auth: false })
      // No stats is not "zero families served", it is "we do not know" — so the
      // line is absent rather than reading as a boast that fell over.
      .then(setStats).catch(() => setStats(null));
  }, [region.slug]);

  /**
   * Split from the fetch above because it waits on the school lookup.
   *
   * This used to request `region.defaultPanjika` — Gupta Press in Kolkata, which is
   * hand-entered under ADR 0003 and has never been entered. The API returned `[]`,
   * `today` stayed null, and the panchang rendered nothing at all. The page looked
   * finished; the feature was simply absent, with no error to notice.
   */
  useEffect(() => {
    // Cleared on every city change, or Mumbai briefly shows Kolkata's tithi.
    setMonth([]); setToday(null);
    if (!school) { setPanchangPending(schoolLoading); return; }
    setPanchangPending(true);

    // `dayList()` starts tomorrow — right for booking, wrong here. The card said
    // "Today" over tomorrow's tithi for as long as it has existed.
    const days = dayList(31, 0);
    api<PanchangDay[]>(
      `/v1/panchang?citySlug=${region.slug}&from=${days[0]}&to=${days.at(-1)}`
      + `&school=${school}&locale=en`, { auth: false },
    ).then((list) => {
      setMonth(list);
      // Matched on the date rather than taking `list[0]`: the stored window may
      // start later than the one requested, and a card headed "Today" must be today.
      setToday(list.find((d) => d.date === days[0]) ?? null);
    })
      .catch(() => { setMonth([]); setToday(null); })
      .finally(() => setPanchangPending(false));
  }, [region.slug, school, schoolLoading]);

  /**
   * Membership and destination come from the same definition, so "See all" always
   * lands on the shelf the devotee was looking at. See `lib/collections.ts`.
   */
  const rails = useMemo(
    () => COLLECTIONS.map((c) => ({ c, ...collectionPreview(c, rituals) })),
    [rituals],
  );
  const railOf = (id: string) => rails.find((r) => r.c.id === id);

  const searchable = useMemo(() => rituals.map((r) => ({
    slug: r.slug,
    name: r.name,
    aliases: aliasesFor(r.slug),
    hint: r.deliveryMode === 'virtual' ? 'Online' : `${Math.round(r.durationMin / 60)} hr · at home`,
  })), [rituals]);


  /**
   * Rounded to the whole rupee, not just displayed that way.
   *
   * This returned raw paise, so a card read "₹5,207.2" — a price carrying a tenth
   * of a rupee, beside a category tile reading a clean "5 services". Rounding at
   * the formatter alone would leave the number and the string disagreeing; this
   * makes the figure itself a rupee amount.
   */
  const total = (r: Ritual) =>
    Math.round((r.priceBand.defaultPaise + r.bomTotalPaise * 1.05) * 1.15 / 100) * 100;


  /** A service wears its category's colour, the same one the tile above uses. */
  const tintOf = (r: Ritual) => getCategory(r.category)?.tint;

  return (
    <>
      {/* ------------------------------------------------------------ hero
          Kept deliberately short. The previous hero ran about 630px before the
          header, so on a laptop the entire first screen was a slogan and four
          trust pills — the same four claims the footer already makes — and the
          first bookable thing on the page sat around 1400px down. A home page
          for a booking service has one job above the fold: let someone say what
          they want. Everything else earns its place below that. */}
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-say">
            <h1>Book a pandit for any pooja</h1>
            <p className="lede">
              Verified purohits, transparent pricing, at your home or online.
            </p>

            <HeroSearch services={searchable} />

            {/*
              Counted, not claimed.

              This read "4.8★ average · 500 verified pandits · 50,000+ families
              served". There were no reviews in the database, so the average was of
              nothing; the pandit count was a round number; and nobody had been
              served, because nothing has launched. Each line below is now a COUNT
              and is omitted entirely when it is zero — an honest gap beats a
              flattering fiction, and it creates the pressure to earn the number.
            */}
            {stats && (
              <p className="hero-trust">
                {[
                  stats.verifiedPandits > 0
                    && <><strong>{stats.verifiedPandits}</strong> verified purohits</>,
                  stats.rituals > 0
                    && <><strong>{stats.rituals}</strong> rituals</>,
                  stats.cities > 0
                    && <><strong>{stats.cities}</strong> cities</>,
                  stats.familiesServed > 0
                    && <><strong>{stats.familiesServed}</strong> families served</>,
                ].filter(Boolean).map((node, i) => (
                  <span key={i}>{i > 0 && ' · '}{node}</span>
                ))}
              </p>
            )}
          </div>

          {/* Beside the search, not beneath it. The hero's right half was empty at
              every width above 900px while the almanac waited below the fold. */}
          <PanchangCard
            today={today}
            upcoming={month}
            cityLabel={chosen ? region.name.en : 'Select your city'}
            time={time}
            pending={panchangPending}
          />

        </div>
      </section>

      {/* ------------------------------------------------------ categories
          Promoted to first content. This is the actual navigation — the answer
          to "what are you looking for" — and it belongs where the eye lands
          after the search box, not two screens beneath it. */}
      <section className="section tight">
        <div className="wrap">
          <div className="rail-head">
            <div>
              <h2>What are you looking for?</h2>
              <p className="muted">Browse by the kind of ceremony you need</p>
            </div>
            <div className="rail-aside">
              {/* Not `/book?browse=1`. That is step one of a checkout with a
                  filter cleared, which is not what "see all categories" promises.
                  `/services` is the readable hub: every category, every ritual
                  under it, with prices, and nothing started. */}
              <Link href="/services" className="seeall">All categories ›</Link>
            </div>
          </div>

          {catError && (
            <div className="notice err" style={{ maxWidth: 620, marginBottom: 22 }}>
              <strong>Categories could not be loaded.</strong> {catError}
              <div className="muted" style={{ fontSize: '.88rem', marginTop: 6 }}>
                Run <code>pnpm db:migrate &amp;&amp; pnpm db:seed</code>, then refresh.
              </div>
            </div>
          )}

          {/* As many placeholders as there are categories, from the same static
              list the API builds its response from — so the reserved height is the
              real height rather than a guess that shifts when the data lands. */}
          <div className="grid cat" aria-busy={catsPending || undefined}>
            {catsPending && <CategoryCardSkeletons count={RITUAL_CATEGORIES.length} />}
            {!catsPending && categories.map((c) => (
              <Link href={`/book?category=${c.id}`} key={c.id} className="cat-card">
                <div className="tile" style={{ background: c.tint }}>{c.emoji}</div>
                <div className="name">{c.en}</div>
                <div className="desc">{c.blurb}</div>
                <div className="count">{c.count} service{c.count === 1 ? '' : 's'}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* A returning family sees their own history before the catalogue. Renders
          nothing for a guest, or for a devotee with none. */}
      <Anniversaries />

      {/* ----------------------------------------------------- most booked */}
      <ServiceRail
        title={railOf('popular')!.c.title}
        subtitle={railOf('popular')!.c.subtitle}
        seeAll={railOf('popular')!.hasMore ? railOf('popular')!.href : undefined}
        count={railOf('popular')!.items.length}
        pending={ritualsPending}
        reserve={railOf('popular')!.c.preview}
      >
        {(railOf('popular')!.items as Ritual[]).map((r) => (
          <ServiceCard
            key={r.id}
            service={r}
            price={money(total(r))}
            emoji={emojiFor(r.slug)}
            tint={tintOf(r)}
            badges={[{ text: 'Popular', kind: 'pop' }]}
            // There was a second chip here reading "15% OFF", generated from a hash
            // of the slug. There is no discount in the pricing engine and no MRP to
            // discount from, so it advertised a saving that did not exist.
            chips={[{ text: r.durationMin >= 240 ? 'Ceremony' : 'Religious' }]}
            features={['Experienced pandit included', 'All pooja materials provided']}
            meta={[
              `⏱ ${Math.round(r.durationMin / 60)}–${Math.round(r.durationMin / 60) + 1} hours`,
              '📍 At your home',
            ]}
          />
        ))}
      </ServiceRail>

      {/*
        "Good days to book" moved to /panchang.

        Auspiciousness is per RITUAL — a good day for Griha Prabesh is not a good
        day for Sraddha — and here it was shown to someone who had not chosen a
        service yet, so it promised a precision it could not have at that point in
        the journey. On the panchang page each day can say what it is good FOR, and
        the booking flow's date step already ranks muhurats once the ritual is known.
      */}
      {/* -------------------------------------------------- new & noteworthy */}
      <ServiceRail
        title={railOf('online')!.c.title}
        subtitle={railOf('online')!.c.subtitle}
        seeAll={railOf('online')!.hasMore ? railOf('online')!.href : undefined}
        count={railOf('online')!.items.length}
        pending={ritualsPending}
        reserve={railOf('online')!.c.preview}
        aside={<span className="badge new" style={{ position: 'static' }}>NEW</span>}
      >
        {(railOf('online')!.items as Ritual[]).map((r) => {
          const remote = r.deliveryMode === 'virtual';
          return (
            <ServiceCard
              key={r.id}
              service={r}
              price={money(total(r))}
              emoji={emojiFor(r.slug)}
              tint={tintOf(r)}
              tone="cool"
              badges={[
                { text: 'NEW', kind: 'new', side: 'l' },
                { text: remote ? 'ONLINE' : 'PERSONALISED', kind: remote ? 'blue' : 'prem' },
              ]}
                chips={[{ text: remote ? 'By video' : 'At your home', kind: 'blue' }]}
              features={[
                remote ? 'No travel, no materials to buy' : 'Shaped around your birth chart',
                'Verified pandit, real time slot',
              ]}
              meta={[`⏱ ${r.durationMin} mins`]}
            />
          );
        })}
      </ServiceRail>

      {/* ------------------------------------------------- most requested */}
      <ServiceRail
        title={railOf('trending')!.c.title}
        subtitle={railOf('trending')!.c.subtitle}
        seeAll={railOf('trending')!.hasMore ? railOf('trending')!.href : undefined}
        count={railOf('trending')!.items.length}
        pending={ritualsPending}
        reserve={railOf('trending')!.c.preview}
      >
        {(railOf('trending')!.items as Ritual[]).map((r) => (
          <ServiceCard
            key={r.id}
            service={r}
            price={money(total(r))}
            emoji={emojiFor(r.slug)}
            tint={tintOf(r)}
            badges={[{ text: 'Popular', kind: 'pop' }]}
            chips={[{ text: 'Ceremony' }]}
            meta={[`⏱ ${Math.round(r.durationMin / 60)} to ${Math.round(r.durationMin / 60) + 2} hours`]}
          />
        ))}
      </ServiceRail>

      {/* ------------------------------------------------------- two ways out
          These were two separate bands saying almost the same thing. "Need a
          pandit in the next two days? — See what's free now" and "Can't find what
          you're looking for? — Request Custom Service" both read as a generic
          catch-all, and the second was worse than vague: it pointed at
          `/book?browse=1`, the ordinary catalogue, so a devotee who could not find
          their ritual was returned to the list that had just failed them.

          They are actually two different problems — a deadline, and not knowing
          what to ask for — so they sit side by side with distinct destinations.
          `personalised-puja` is a real, priced catalogue row, which is what a
          bespoke request should land on. */}
      <section className="section tight">
        <div className="wrap">
          {/* Built on the category tile: centred icon, title, one line, an
              orange lead-in. Two card languages on one page made these read as
              adverts rather than as part of the catalogue. */}
          <div className="outband">
            <Link href="/book?when=soon" className="outcard">
              <span className="tile" style={{ background: 'linear-gradient(135deg,#60A5FA,#2563EB)' }}>
                ⚡
              </span>
              <span className="name">Need someone in 48 hours?</span>
              <span className="desc">
                Any ritual, at short notice — only pandits with slots genuinely free
              </span>
              <span className="go">See who is free ›</span>
            </Link>

            <Link href="/pooja/personalised-puja" className="outcard">
              <span className="tile" style={{ background: 'linear-gradient(135deg,#818CF8,#4F46E5)' }}>
                🪐
              </span>
              <span className="name">Not one of the rituals listed?</span>
              <span className="desc">
                Planned around your family&apos;s tradition and birth chart, quoted first
              </span>
              <span className="go">About a personalised puja ›</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ offers
          Renders nothing when there is no live plan for this city. Every number
          used to be a literal typed into this file — see components/home/offer-card. */}
      {(offer || offerError) && (
        <section className="section tight">
          <div className="wrap">
            <OfferCard offer={offer} money={money} />
            {/* Development only: in production an unreachable offer is simply no
                offer, but on a developer's machine it is nearly always a migration
                that has not been run, and silence costs an afternoon. */}
            {!offer && offerError && process.env.NODE_ENV !== 'production' && (
              <div className="notice warn">
                <strong>The membership offer could not be loaded.</strong> {offerError}
                <div className="muted" style={{ fontSize: '.88rem', marginTop: 6 }}>
                  Usually a pending migration — run{' '}
                  <code>pnpm db:migrate &amp;&amp; pnpm db:seed</code>, then restart the API.
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* The old "Request Custom Service" lived here and went to the catalogue.
          The bespoke route is now a card above; this is the human one, and it
          reaches an actual inbox. */}
      <section className="section tight" style={{ textAlign: 'center' }}>
        <div className="wrap">
          <p className="muted">Still not sure? Ask us — we answer on WhatsApp.</p>
          <Link href="/contact" className="btn pillghost">💬 Talk to someone</Link>
        </div>
      </section>
    </>
  );
}
