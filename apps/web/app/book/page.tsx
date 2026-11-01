'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { payForBooking } from '@/lib/checkout';
import { useRegion } from '@/lib/region-context';
import { AddressForm } from '@/components/address-form';
import { dayList } from '@/lib/format';
import { PanjikaPrompt } from '../panjika-prompt';
import { OccasionPicker } from '@/components/occasion-picker';
import { usePanchangSchool } from '@/lib/panchang-school';
import { ServiceCardSkeletons } from '@/components/skeletons';
import { getCollection } from '@/lib/collections';
import { ritualImageVariants, ritualImagePath } from '@/lib/ritual-images';
import { bestMuhurats } from '@themaithil/region';
import { computePrice } from '@themaithil/contracts';

interface Ritual {
  id: string; slug: string; name: string; shortDescription: string;
  durationMin: number; defaultSlotSpan: number; bomTotalPaise: number; bomItemCount?: number;
  deliveryMode: 'at_home' | 'virtual'; category: string;
  priceBand: { minPaise: number; maxPaise: number; defaultPaise: number };
}
interface Purohit {
  id: string; name: string; experienceYears: number; languages: string[];
  rating: number | null; ratingCount: number; pricePaise: number;
  distanceKm: number | null; isNewPandit: boolean;
}
interface Price {
  dakshinaPaise: number; samagriPaise: number; travelPaise: number;
  platformFeePaise: number; discountPaise: number; totalPaise: number;
  tokenPaise: number; balancePaise: number; surgeBps: number; commissionBps: number;
}
interface PanchangDay {
  date: string; tithiAtSunrise: string; nakshatraAtSunrise: string;
  abhijit: { startsAt: string; endsAt: string } | null;
  rahuKaal: { startsAt: string; endsAt: string } | null;
  auspiciousForRitualIds: string[]; schoolsDisagree: boolean;
}
interface BookableTime {
  startsAt: string; endsAt: string; available: boolean; purohitCount: number;
}
interface Address {
  id: string; label: string | null; line1: string; line2: string | null;
  /** The address's OWN city, joined in by the API — never the selected region. */
  city: string; citySlug: string;
  pincode: string;
}

/**
 * Three steps, not four.
 *
 * "Pandit" was a grid the devotee had no basis to choose from — "18 years" against
 * "22 years" is not a decision a family can make about a ceremony, so it added
 * anxiety without adding information. The platform now assigns on rating,
 * proximity, acceptance rate, experience and availability. Booking a NAMED purohit
 * is a separate entry point, from their profile. See ADR 0012.
 */
const STEPS = ['Service', 'Date & time', 'Confirm'];

/**
 * The day, in the bands a family actually says out loud.
 *
 * Forty-eight buttons in one run cannot be scanned. These are not arbitrary
 * thirds: Brahma muhurta is a named window before dawn that the catalogue's
 * muhurat-sensitive rites are timed to, and the night band is what makes the
 * midnight Kali Puja and the four-prahar Shiva Ratri bookable at all — both are
 * sold today and neither fits the 06:00–19:30 grid this replaces.
 *
 * A band with nothing in it does not render, so a purohit who has not opted into
 * night hours simply shows a normal day.
 */
const TIME_BANDS = [
  { id: 'brahma', label: 'Brahma muhurta', note: 'Before dawn', from: 3, to: 6 },
  { id: 'morning', label: 'Morning', note: '', from: 6, to: 12 },
  { id: 'afternoon', label: 'Afternoon', note: '', from: 12, to: 17 },
  { id: 'evening', label: 'Evening', note: '', from: 17, to: 21 },
  { id: 'night', label: 'Night', note: 'For rites performed after dark', from: 21, to: 24 },
  { id: 'latenight', label: 'After midnight', note: '', from: 0, to: 3 },
] as const;

/** Hour of day in the city's own zone, which is what the bands are about. */
const localHour = (iso: string) =>
  Number(new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date(iso)));
const overlaps = (a: string, b: string, c: string, d: string) =>
  new Date(a) < new Date(d) && new Date(c) < new Date(b);

/**
 * Scrolls the next thing to do into view.
 *
 * Choosing a date used to reveal the time grid below the panjika panel, and choosing a
 * time used to reveal the pandit list below that — both often off-screen. The page
 * changed, the viewport did not, so it read as "nothing happened".
 *
 * `block: 'start'` with a margin keeps the heading visible rather than flush against
 * the sticky header, and the guard respects a reduced-motion preference.
 */
const revealNext = (el: HTMLElement | null) => {
  if (!el) return;
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
};

function BookInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { region, money, time, date: fmtDate } = useRegion();

  const [signedIn, setSignedIn] = useState(false);
  const [loadingCatalogue, setLoadingCatalogue] = useState(true);
  const [needsPanjika, setNeedsPanjika] = useState(false);

  const [rituals, setRituals] = useState<Ritual[]>([]);
  const [panchang, setPanchang] = useState<Record<string, PanchangDay>>({});
  const [q, setQ] = useState(params.get('q') ?? '');
  const [category, setCategory] = useState<string | null>(params.get('category'));
  const [categories, setCategories] = useState<Array<{
    id: string; en: string; emoji: string; count: number;
  }>>([]);

  const [ritual, setRitual] = useState<Ritual | null>(null);
  /**
   * `?day=YYYY-MM-DD` preselects the date.
   *
   * The home page lists the month's auspicious dates. Those were read-only, so a
   * devotee who spotted a good day had to memorise it and find it again inside
   * this flow — the commonest way an intention gets dropped. This does not skip a
   * step: `step` is still driven by the service, so they land on the catalogue as
   * usual and the date is already chosen when they get to it.
   */
  const [day, setDay] = useState<string>(
    /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day')! : '',
  );
  /** The chosen start INSTANT, which is what actually gets booked (ADR 0013). */
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [times, setTimes] = useState<BookableTime[]>([]);
  const [loadingTimes, setLoadingTimes] = useState(false);
  const [pandits, setPandits] = useState<Purohit[]>([]);
  const [samagri, setSamagri] = useState<'pandit_brings' | 'none'>('pandit_brings');
  const [payment, setPayment] = useState<'cash' | 'digital_full'>('cash');

  const [draft, setDraft] = useState<{
    id: string; price: Price;
    pandit?: {
      id: string; name: string; experienceYears: number;
      photoUrl?: string | null;
      chantingSampleUrl?: string | null; chantingSampleLabel?: string | null;
    };
  } | null>(null);
  const [otps, setOtps] = useState<{ startOtp?: string; completeOtp?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Searching for pandits is a network round trip; without this the UI looked frozen. */
  const [searching, setSearching] = useState(false);
  const [slotErr, setSlotErr] = useState<string | null>(null);

  /**
   * The flow never asked where the puja happens. Only the demo devotee had an
   * address row, so every real account reached the end and was told "no saved
   * address" with nowhere in the product to add one.
   */
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);
  /**
   * Where confirmations and the start/completion codes will go.
   *
   * The whole notification pipeline is WhatsApp-first with an SMS fallback, and the
   * OTPs that begin and end the puja are sent to this number — and it was never
   * shown on the screen where the booking is made. A devotee who signed up on a
   * relative's phone, or mistyped a digit at OTP, finds out on the day.
   */
  const [myPhone, setMyPhone] = useState<string | null>(null);

  const timeRef = useRef<HTMLDivElement>(null);
  const panditRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  /**
   * Browsing does NOT require an account.
   *
   * Sending someone to a login wall before they have seen a service or a price is
   * where bookings are lost. Auth is demanded at the one point it is genuinely
   * needed - creating the booking - and the flow resumes where they left off.
   */
  useEffect(() => {
    setSignedIn(Boolean(auth.token));
    if (!auth.token) return;
    api<{ panjikaSchool: string | null; phone: string }>('/v1/auth/me')
      .then((me) => {
        setNeedsPanjika(me.panjikaSchool === null && region.panjikas.length > 1);
        setMyPhone(me.phone ?? null);
      })
      .catch(() => {});
    api<Address[]>('/v1/me/addresses').then((list) => {
      setAddresses(list);
      // Most recent first, so the obvious default is the one they last used.
      setAddressId((cur) => cur ?? list[0]?.id ?? null);
      if (list.length === 0) setAddingAddress(true);
    }).catch(() => {});
  }, [region.panjikas.length]);

  /**
   * `?ritual=<slug>` preselects the service, so "Book Now" on a card lands the user
   * on the date step instead of the catalogue they just came from.
   */
  /**
   * `?when=soon` is what the "Express Booking" card became. It was never a service —
   * every ritual can be booked at short notice — so it narrows the date strip to the
   * next two days rather than pretending to be a row in the catalogue.
   */
  const [soon, setSoon] = useState(params.get('when') === 'soon');

  /**
   * Occasions are the default entry; the catalogue is opt-in. Arriving with a
   * category, a search or a named ritual means the devotee already knows what they
   * want, so we do not put a question in front of them.
   */
  const [browsing, setBrowsing] = useState(
    Boolean(params.get('browse') || params.get('category')
            || params.get('q') || params.get('ritual') || params.get('collection')),
  );

  /**
   * `?collection=popular` and friends.
   *
   * Every "See all" on the home page used to land here on `?browse=1` — the entire
   * catalogue, in a different order, with no sign of which rail you had come from.
   * The link looked like navigation and behaved like a reset. The collection is
   * defined once in `lib/collections.ts`; the rail renders its first four and this
   * renders the rest under the same heading.
   */
  const collection = getCollection(params.get('collection'));

  /**
   * `?ritual=` is an opening intent, applied exactly once.
   *
   * This effect used to depend on `ritual` and re-run whenever it went null — so
   * "Change service" set the ritual to null, the effect immediately read the slug
   * still sitting in the URL and set it straight back. The button worked perfectly
   * and nothing on screen ever moved, which is the worst kind of broken: there was
   * no error to see and no way to tell it apart from a dead control.
   *
   * The ref records that the URL has been honoured. It is deliberately not state:
   * consuming the parameter must not itself cause a render, and it must survive
   * the very re-render it is guarding against.
   */
  const wanted = params.get('ritual');
  const consumedRitual = useRef(false);
  useEffect(() => {
    if (consumedRitual.current || !wanted || rituals.length === 0) return;
    const match = rituals.find((r) => r.slug === wanted);
    if (!match) return;
    consumedRitual.current = true;
    setRitual(match);
  }, [wanted, rituals]);

  useEffect(() => {
    setLoadingCatalogue(true);
    // Filtering happens in SQL rather than in the browser, so a large catalogue does
    // not have to be shipped to filter it down to four cards.
    const qs = new URLSearchParams({ citySlug: region.slug, locale: 'en' });
    if (category) qs.set('category', category);
    let live = true;
    api<Ritual[]>(`/v1/rituals?${qs}`, { auth: false })
      /*
       * Guarded, because `category` changes as fast as a finger can tap a chip and
       * these responses are not ordered. Two requests in flight meant the SLOWER
       * one won: tap "Festivals" then "Life ceremonies" quickly and the grid could
       * settle on Festivals, under a chip reading Life ceremonies. Nothing errors —
       * the catalogue is simply the wrong one, which is the hardest kind to notice.
       */
      .then((list) => { if (live) setRituals(list); })
      .catch(() => { if (live) setRituals([]); })
      .finally(() => { if (live) setLoadingCatalogue(false); });
    return () => { live = false; };
  }, [region.slug, category]);

  /**
   * The category chips themselves, which depend ONLY on the city.
   *
   * This sat in the effect above, keyed on `[region.slug, category]`, so choosing a
   * category refetched the list of categories — the one thing on screen that could
   * not have changed as a result. Every chip tap paid for a second request whose
   * response was byte-identical to the one already rendered.
   *
   * The same fault was found and fixed for the panchang a few lines down ("split
   * out of the catalogue effect above, which re-ran on every category chip and
   * refetched 21 days with it"); the categories call was left behind in it.
   */
  /**
   * Whether this deployment takes money online, from the server rather than the
   * bundle.
   *
   * The estimate below runs the same `computePrice` the API does, so it has to know
   * whether a token will be charged or the whole amount is cash on the day. A
   * `NEXT_PUBLIC_` variable would bake the answer into the JavaScript, and the stale
   * copy would be the one in a browser still showing "Pay online now" for money
   * nobody is going to take.
   *
   * Defaults to TRUE while in flight, matching the server's own default, so a slow
   * response never briefly promises a free booking.
   */
  const [paymentsEnabled, setPaymentsEnabled] = useState(true);
  useEffect(() => {
    let live = true;
    api<{ paymentsEnabled: boolean }>('/v1/config', { auth: false })
      .then((c) => { if (live) setPaymentsEnabled(c.paymentsEnabled); })
      .catch(() => { /* keep the safe default */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    api<typeof categories>(`/v1/categories?citySlug=${region.slug}`, { auth: false })
      .then((list) => { if (live) setCategories(list); })
      .catch((e) => { if (live) setErr(`Categories unavailable: ${(e as Error).message}`); });
    return () => { live = false; };
  }, [region.slug]);

  /**
   * The almanac, resolved rather than assumed — and split out of the catalogue
   * effect above, which re-ran on every category chip and refetched 21 days with it.
   *
   * This asked for `region.defaultPanjika`. In Kolkata that is Gupta Press, which
   * ADR 0003 has transcribed by hand and nobody has transcribed, so the API
   * answered `[]` and `panchang` stayed empty — on the one screen where the
   * almanac decides something. The whole panchang layer of this flow was therefore
   * absent, silently: no muhurat shortlist, not one date chip flagged under a hint
   * reading "auspicious dates are flagged", no tithi panel, no slot marked Abhijit
   * or Rahu Kaal — below a line promising "Rahu Kaal is shown so you can avoid it".
   *
   * `usePanchangSchool` was written for exactly this and wired into `/` and
   * `/panchang`; this page was missed. It asks which schools actually hold data,
   * honours the region's preference when that is one of them, and falls back to a
   * computable one rather than to nothing.
   */
  const { school: panjika, substituted } = usePanchangSchool();

  useEffect(() => {
    // Cleared on a city or almanac change, or the old city's tithis sit under the
    // new city's dates until the next response lands.
    setPanchang({});
    if (!panjika) return;
    let live = true;
    const days = dayList(21);
    api<PanchangDay[]>(
      `/v1/panchang?citySlug=${region.slug}&from=${days[0]}&to=${days.at(-1)}`
      + `&school=${panjika}&locale=en`, { auth: false },
    )
      .then((l) => { if (live) setPanchang(Object.fromEntries(l.map((d) => [d.date, d]))); })
      .catch(() => { if (live) setPanchang({}); });
    return () => { live = false; };
  }, [region.slug, panjika]);

  /**
   * Resume an interrupted booking once the catalogue has loaded.
   *
   * THIS READ A FIELD `book()` HAS NEVER WRITTEN. The hand-off is the one place in
   * the flow where a devotee is sent away and asked to come back, so it is the one
   * place where "resumes exactly where they left off" is a promise rather than a
   * convenience — and under ADR 0013 it was quietly broken.
   *
   * `book()` stores `startsAt`, the instant actually chosen. This read `p.slotIdx`,
   * which that payload has not carried since the flow moved off slot indices. So
   * `slotIdx` was `undefined`, the search URL was built with the literal string
   * "undefined", `z.coerce.number()` turned it into `NaN`, `.int()` rejected it, and
   * the 422 went into a `.catch(() => {})`. Nothing was logged and nothing was shown.
   *
   * What the devotee saw: they picked a ritual, a date and a time, pressed "Sign in
   * to book", signed in, came back — and found the ritual and the date restored, the
   * TIME blank, and no purohits. They had to choose the time again, at the exact
   * moment they had already decided to buy.
   *
   * `startsAt` is restored and the window is rebuilt from the ritual's duration, the
   * same way `book()` and `matchPandit` derive it — so the resumed search asks the
   * same question the original one did.
   */
  useEffect(() => {
    if (!signedIn || rituals.length === 0 || ritual) return;
    const raw = sessionStorage.getItem('themaithil.pending');
    if (!raw) return;
    sessionStorage.removeItem('themaithil.pending');
    try {
      const p = JSON.parse(raw) as {
        ritualId: string; date: string; startsAt?: string;
        samagri: 'pandit_brings' | 'none'; payment: 'cash' | 'digital_full';
      };
      const r = rituals.find((x) => x.id === p.ritualId);
      if (!r) return;
      setRitual(r); setDay(p.date);
      setSamagri(p.samagri); setPayment(p.payment);
      // An older payload from a tab open across the deploy has no `startsAt`; the
      // ritual and date are still worth restoring, and the time step asks again.
      if (!p.startsAt) return;
      setStartsAt(p.startsAt);
      const endsAt = new Date(
        new Date(p.startsAt).getTime() + r.durationMin * 60_000,
      ).toISOString();
      void api<{ results: Purohit[] }>(
        `/v1/search/pandits?citySlug=${region.slug}&ritualId=${p.ritualId}`
        + `&date=${p.date}&startsAt=${encodeURIComponent(p.startsAt)}`
        + `&endsAt=${encodeURIComponent(endsAt)}`, { auth: false },
      ).then((res) => {
        setPandits(res.results);
        /*
         * The window can have been taken while they were signing in — which is
         * precisely the window this path leaves open. Say so here rather than
         * letting them press Review and book and meet `createBooking`'s refusal.
         */
        if (res.results.length === 0) {
          /*
           * `startsAt` STAYS SET. The notice renders beside the time picker and is
           * gated on `startsAt` being present (it is the "we searched this window
           * and found nobody" state), so clearing it here would hide the very
           * message being set — the same shape as `findPandits`, which also keeps
           * the chosen time and lets the devotee pick a different one.
           */
          setSlotErr('That time was taken while you were signing in. '
                   + 'Pick another and we will pick up where you left off.');
        }
      }).catch(() => {});
    } catch { /* corrupt payload, start fresh */ }
  }, [signedIn, rituals, ritual, region.slug]);

  /**
   * The good days, ranked, from the panchang we already fetch. Empty when nothing
   * is genuinely marked — the shortlist is not padded, so an empty result means
   * "we have nothing special to tell you", and the full calendar is shown instead.
   */
  const muhurats = useMemo(() => {
    if (!ritual) return [];
    const days = dayList(soon ? 2 : 21)
      .map((d) => panchang[d]).filter((d): d is PanchangDay => Boolean(d));
    return bestMuhurats(days, ritual.id, 5);
  }, [ritual, panchang, soon]);

  /** Opened by the devotee; the shortlist is what they see first. */
  const [allDates, setAllDates] = useState(false);

  /**
   * The day's start times. Fetched per ritual+date because what is offerable
   * depends on the ritual's duration — a 90-minute puja fits places a six-hour
   * wedding does not.
   */
  useEffect(() => {
    if (!ritual || !day) { setTimes([]); return; }
    let live = true;
    setLoadingTimes(true);
    api<{ times: BookableTime[] }>(
      `/v1/availability/times?ritualId=${ritual.id}&citySlug=${region.slug}&date=${day}`,
      { auth: false },
    )
      .then((r) => { if (live) setTimes(r.times); })
      .catch(() => { if (live) setTimes([]); })
      .finally(() => { if (live) setLoadingTimes(false); });
    return () => { live = false; };
  }, [ritual?.id, day, region.slug]);

  const chooseTime = (t: BookableTime) => {
    if (!ritual) return;
    setStartsAt(t.startsAt);
    setDraft(null); setErr(null); setSlotErr(null);
    requestAnimationFrame(() => revealNext(panditRef.current));
    void findPandits(ritual, day, t);
  };

  const step = !ritual ? 1 : startsAt === null ? 2 : 3;
  const virtual = ritual?.deliveryMode === 'virtual';
  /**
   * A remote booking settles online, always: there is no doorstep at which cash
   * could change hands. Derived rather than stored, so the estimate, the split and
   * the payload cannot disagree with the sentence the devotee is shown.
   */
  const effectivePayment: 'cash' | 'digital_full' = virtual ? 'digital_full' : payment;
  const shown = useMemo(() => {
    // The collection narrows first, so a search inside "New and noteworthy"
    // searches that shelf rather than silently escaping to the whole catalogue.
    const base = collection ? collection.select(rituals) as Ritual[] : rituals;
    const n = q.trim().toLowerCase();
    return n ? base.filter((r) => r.name.toLowerCase().includes(n)
      || r.shortDescription.toLowerCase().includes(n)) : base;
  }, [rituals, q, collection]);

  /*
   * The same photo, per ritual, everywhere the ritual appears - see
   * lib/ritual-images.ts, shared with the home page so the two never drift.
   * Computed over the FULL catalogue rather than the currently filtered
   * `shown` list, so a ritual's photo does not change depending on which
   * search or category filter happens to be active when it renders.
   */
  const imageVariantOf = useMemo(() => ritualImageVariants(rituals), [rituals]);
  const imageOf = (r: Ritual) => ritualImagePath(r, imageVariantOf);

  const findPandits = useCallback(async (r: Ritual, d: string, t: BookableTime) => {
    setErr(null); setSlotErr(null); setPandits([]); setSearching(true);
    try {
      // Availability is asked by TIME now, not slot index — the search filters on
      // the purohit's declared working hours and their actual bookings (ADR 0013).
      const res = await api<{ results: Purohit[] }>(
        `/v1/search/pandits?citySlug=${region.slug}&ritualId=${r.id}`
        + `&date=${d}&startsAt=${encodeURIComponent(t.startsAt)}`
        + `&endsAt=${encodeURIComponent(t.endsAt)}`,
        { auth: false });
      setPandits(res.results);
      // A "no results" message belongs beside the slots that produced it, not in a
      // banner at the top of the page where the user is no longer looking.
      if (res.results.length === 0) {
        setSlotErr('No pandit is free at that time. Try another time or another date.');
      } else {
        // Every earlier transition in this flow scrolls the next thing into
        // view (see `revealNext`) - this was the one step missing it. The
        // options/confirm card renders the moment `searching` clears, but on a
        // long catalogue page it lands well below the fold, so it read as
        // nothing having happened after a successful search.
        requestAnimationFrame(() => revealNext(optionsRef.current));
      }
    } catch (e) {
      setSlotErr((e as Error).message);
    } finally {
      setSearching(false);
    }
  }, [region.slug]);

  const chooseDay = (d: string) => {
    setDay(d); setStartsAt(null); setPandits([]); setSlotErr(null);
    requestAnimationFrame(() => revealNext(timeRef.current));
  };

  /*
   * `useMyLocation` and `saveAddress` moved to `components/address-form.tsx` when
   * the account page needed the same form. The geolocation handshake and the
   * `citySlug: region.slug` the API requires now have exactly one implementation.
   */
  const book = async () => {
    if (!ritual || !startsAt) return;
    if (!auth.token) {
      // Keep the whole selection so the flow resumes exactly here after signing in.
      sessionStorage.setItem('themaithil.pending', JSON.stringify({
        ritualId: ritual.id, date: day, startsAt, samagri, payment,
      }));
      router.push('/login?next=/book');
      return;
    }
    // A remote service has no venue; everything else needs one chosen first.
    if (!virtual && !addressId) {
      setErr('Choose where the pandit should come, or add an address.');
      setAddingAddress(true);
      return;
    }

    setBusy(true); setErr(null);
    try {
      const created = await api<{
        id: string; price: Price;
        pandit: {
          id: string; name: string; experienceYears: number;
          chantingSampleUrl?: string | null; chantingSampleLabel?: string | null;
        };
      }>('/v1/bookings', {
        method: 'POST',
        body: JSON.stringify({
          // No panditId: the platform assigns. ADR 0012.
          ritualId: ritual.id, addressId,
          date: day, startsAt,
          // No purohit carries samagri down a video call; virtual is always 'none'.
          samagriOption: virtual ? 'none' : samagri,
            paymentMode: effectivePayment, attendeeCount: 20,
        }),
      });
      setDraft(created);
      /*
       * CASH-ONLY DEPLOYMENTS CONFIRM HERE, and the server says so rather than the
       * client guessing.
       *
       * With a gateway this leaves the booking `pending_accept` and the devotee
       * presses Pay next. With `PAYMENTS_ENABLED=false` there is nothing to pay, so
       * the API confirms on submission and answers with the start and completion
       * codes exactly as a captured payment would — which is the signal to skip the
       * payment step and show the confirmation.
       *
       * Read from the RESPONSE rather than from a config flag shipped to the
       * browser: the server is the only thing that knows whether money was taken,
       * and a stale bundle cannot then offer a Pay button that cannot work.
       */
      const submitted = await api<{
        state?: string; startOtp?: string; completeOtp?: string;
      }>(`/v1/bookings/${created.id}/submit`, { method: 'POST' });
      if (submitted.state === 'confirmed') {
        setOtps({ startOtp: submitted.startOtp, completeOtp: submitted.completeOtp });
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /**
   * Both this screen and the account page's "Pay now" go through `payForBooking`.
   *
   * They used to hold separate copies of this, and the copies disagreed: this one
   * branched on `keyId` — null means the fake gateway, absent outside development —
   * while the account page called the dev shortcut unconditionally and so answered
   * 403 in production. One routine means the branch cannot be forgotten again.
   */
  const pay = async () => {
    if (!draft) return;
    setBusy(true); setErr(null);
    try {
      const outcome = await payForBooking({
        bookingId: draft.id,
        description: ritual?.name ?? 'Puja booking',
        prefillName: auth.name,
      }, api);

      // Closing the sheet is an ordinary thing to do. The booking is untouched and
      // the button still says pay, so there is nothing to report and nothing to fix.
      if (outcome.status === 'dismissed') return;
      if (outcome.status === 'failed') { setErr(outcome.reason); return; }
      if (outcome.status === 'pending') {
        setErr('Your payment went through and we are still confirming it. '
             + 'Check My bookings in a moment — do not pay again.');
        return;
      }
      setOtps(outcome.codes);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const reset = () => {
    consumedRitual.current = true;
    setRitual(null); setDay('');
    setPandits([]); setDraft(null); setOtps(null);
    setErr(null); setSlotErr(null); setSearching(false);
    // The catalogue, not the occasion picker: they have already told us the
    // occasion once and are changing their mind about the ritual, not the reason.
    setBrowsing(true);
    /**
     * Drop `?ritual=` from the address bar too. The ref alone stops it being
     * re-applied in this session, but leaving it in the URL means a refresh — or a
     * shared link — silently reinstates the service they just rejected.
     */
    if (wanted) {
      const next = new URLSearchParams(params.toString());
      next.delete('ritual');
      next.set('browse', '1');
      router.replace(`/book?${next.toString()}`, { scroll: false });
    }
  };

  /** Step back one stage instead of losing the whole selection. */
  const backTo = (target: 1 | 2) => {
    setErr(null); setSlotErr(null);
    if (target <= 1) reset();
  };

  if (needsPanjika) {
    return <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <PanjikaPrompt onDone={() => setNeedsPanjika(false)} />
    </div>;
  }

  /**
   * The same `computePrice` the API uses, not a second approximation of it.
   *
   * This was hand-rolled here — `(dakshina + bom * 1.05) * 1.15` — which baked in
   * the standard commission as a literal and ignored `paymentMode` entirely. So a
   * devotee choosing "Pay fully online, 3% lower commission" watched the total not
   * move, and the estimate quietly disagreed with the bill they were about to be
   * shown. Importing the real function costs nothing (it already ships in
   * `@themaithil/contracts`, which this page imports) and it cannot drift, because
   * there is only one of it.
   *
   * Travel and promo are zero here: neither is known until an address is chosen and
   * the server quotes, so the estimate is honest about being a floor.
   */
  const estimated = ritual
    ? computePrice({
        dakshinaBasePaise: ritual.priceBand.defaultPaise as never,
        bomTotalPaise: ritual.bomTotalPaise as never,
        travelFeePaise: 0 as never,
        surgeBps: 10_000,
        samagriOption: virtual ? 'none' : samagri,
        paymentMode: effectivePayment,
        // Cash-only deployments charge no token, so the estimate must not show one.
        paymentsEnabled,
      })
    : null;
  const estimate = estimated?.totalPaise ?? 0;
  const price = draft?.price;
  /** The real quote once drafted, else the estimate — same shape either way. */
  const quote = price ?? estimated;

  return (
    <div className="wrap" style={{ padding: '34px 20px 80px' }}>
      <h1 style={{ fontSize: '1.9rem' }}>Book a pandit</h1>
      <p className="sub">
        {loadingCatalogue
          ? `Loading services in ${region.name.en}…`
          : `${rituals.length} services in ${region.name.en}.`}{' '}
        Pick a real time slot — no waiting to be allocated.
      </p>

      {/* A completed step is clickable, so the stepper is navigation rather than
          decoration — otherwise the only way back was to discard the whole booking. */}
      <div className="stepper">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const done = step > n;
          return (
            <div key={s} style={{ display: 'contents' }}>
              <button type="button"
                      className={`st ${step === n ? 'on' : done ? 'done' : ''}`}
                      disabled={!done || Boolean(draft)}
                      aria-current={step === n ? 'step' : undefined}
                      onClick={() => backTo(n as 1 | 2)}>
                {/* Decorative: the number duplicates the label's position and the
                    tick duplicates aria-current. Announcing "1 Service" is noise. */}
                <span className="dot" aria-hidden="true">{done ? '✓' : n}</span>
                <span className="lb">{s}</span>
              </button>
              {i < STEPS.length - 1 && <span className="bar" />}
            </div>
          );
        })}
      </div>

      {err && <div className="notice err">{err}</div>}

      <div className="book-layout">
        <div>
          {/* 1 — occasion, then service */}
          {!ritual && !browsing && (
            <OccasionPicker rituals={rituals} money={money}
                            onPick={(r) => setRitual(r)} onBrowse={() => setBrowsing(true)} />
          )}

          {!ritual && browsing && (
            <>
              {/* Arriving from a "See all" must feel continuous with the rail it
                  came from, so the shelf keeps its name and offers a way back out
                  to the full catalogue rather than silently being it. */}
              {collection && (
                <div className="shelf-head">
                  <div>
                    <h2>{collection.title}</h2>
                    <p className="muted">{collection.subtitle}</p>
                  </div>
                  <Link href="/book?browse=1" className="seeall">All services ›</Link>
                </div>
              )}

              <input value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder={collection ? `Search ${collection.title.toLowerCase()}…` : 'Search services…'}
                     aria-label="Search services"
                     style={{ width: '100%', maxWidth: 420, marginBottom: 16 }} />

              {categories.length > 0 && (
                <div className="catbar" role="group" aria-label="Filter by category">
                  <button className={`catchip${category === null ? ' on' : ''}`}
                          onClick={() => setCategory(null)}>
                    All services
                  </button>
                  {categories.map((c) => (
                    <button key={c.id}
                            className={`catchip${category === c.id ? ' on' : ''}`}
                            onClick={() => setCategory(c.id)}>
                      <img className="catchip-photo" src={`/images/categories/${c.id}.jpg`} alt="" aria-hidden />
                      {c.en}
                      <span className="n">{c.count}</span>
                    </button>
                  ))}
                </div>
              )}
              {loadingCatalogue && (
                <div className="grid svc" aria-busy>
                  <ServiceCardSkeletons count={6} />
                </div>
              )}

              {!loadingCatalogue && shown.length === 0 && (
                <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                  <h3 style={{ margin: 0 }}>
                    {q || category ? 'No services match those filters' : 'Services could not be loaded'}
                  </h3>
                  {/* "Check that the API is running on port 3000" is an
                      instruction only one of these two readers can follow. */}
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {q || category
                      ? 'Try a different word, or clear the filters to see everything.'
                      : process.env.NODE_ENV !== 'production'
                        ? 'Check that the API is running on port 3000, then refresh.'
                        : 'Please refresh in a moment. If it keeps happening, message us on WhatsApp and we will book it for you.'}
                  </p>
                </div>
              )}

              <div className="grid svc">
                {shown.map((r) => (
                  <div key={r.id} className="svc-card">
                    <div className="svc-photo">
                      <img src={imageOf(r)} alt={r.name} loading="lazy" />
                    </div>
                    <div className="svc-body">
                      <div className="title">{r.name}</div>
                      <div className="desc">{r.shortDescription}</div>
                      <div className="meta">
                        <span>⏱ {Math.round(r.durationMin / 60)}–{Math.round(r.durationMin / 60) + 1} hrs</span>
                        <span>
                          {r.deliveryMode === 'virtual' ? '💻 Online' : '📍 At your home'}
                        </span>
                      </div>
                      <div className="price">from {money(r.priceBand.minPaise)}</div>
                      {/* Reading about a ₹3,000 ritual and committing to it are two
                          different intents; one control cannot serve both. */}
                      <div className="svc-actions">
                        <Link href={`/pooja/${r.slug}`} className="btn outline block">
                          Details
                        </Link>
                        <button className="btn block" onClick={() => setRitual(r)}>
                          Select
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 2 — date & time */}
          {ritual && !draft && (
            <>
              <div className="card chosen" style={{ marginBottom: 20 }}>
                <div className="spread">
                  <div className="chosen-ritual">
                    <img className="chosen-photo" src={imageOf(ritual)} alt="" aria-hidden />
                    <div>
                      <span className="steplabel">Step 1 · chosen</span>
                      <div style={{ fontWeight: 700 }}>{ritual.name}</div>
                      <div className="muted" style={{ fontSize: '.9rem' }}>
                        {ritual.durationMin} minutes
                        {ritual.defaultSlotSpan > 1 && ` · needs ${ritual.defaultSlotSpan} slots`}
                      </div>
                    </div>
                  </div>
                  <button className="btn outline sm" onClick={reset}>Change service</button>
                </div>
              </div>

              {/*
                Once a time is chosen this step collapses to a single line, the
                same way step 1 does.

                It used to stay fully open: the date strip and twenty-five time
                buttons remained on screen while step 3 rendered underneath, so the
                page ran to ~2,800px and a devotee scrolled past a thousand pixels
                of decisions they had already made to reach the button. A checkout
                should be a summary you confirm, not a form you are still filling
                in. "Change time" moves here with it, so the control that undoes a
                choice sits with the choice rather than in the next step's header.
              */}
              {startsAt ? (
                <div className="card chosen" style={{ marginBottom: 20 }}>
                  <div className="spread">
                    <div>
                      <span className="steplabel">Step 2 · chosen</span>
                      <div style={{ fontWeight: 700 }}>
                        {fmtDate(day)} at {time(startsAt)}
                      </div>
                      {/* The END time, not the duration again — step 1's card
                          already states how long the ritual runs, and what a
                          family wants from this line is when their day is
                          their own again. */}
                      <div className="muted" style={{ fontSize: '.9rem' }}>
                        {(() => {
                          const chosen = times.find((t) => t.startsAt === startsAt);
                          return chosen ? `Until about ${time(chosen.endsAt)}` : null;
                        })()}
                      </div>
                    </div>
                    <button className="btn outline sm" onClick={() => backTo(2)}>
                      Change time
                    </button>
                  </div>
                </div>
              ) : (
              <>
              <div className="spread" style={{ margin: '0 0 14px' }}>
                <h2 className="stephead">Step 2 of 3 — when would you like it?</h2>
              </div>

              {/* Sub-step A ------------------------------------------------ */}
              <div className="substep">
                <div className="substep-head">
                  <span className="ix">1</span>
                  <div>
                    <h3>Choose a date</h3>
                    <p className="hint">
                      {muhurats.length > 0 && !allDates
                        ? 'The best days for this ritual, by your panjika.'
                        : 'Next 21 days. Auspicious dates are flagged.'}
                    </p>
                  </div>
                  {(muhurats.length === 0 || allDates) && (
                    <span className="muted scroll-hint">scroll for more →</span>
                  )}
                </div>

                {/*
                  Which almanac these dates come from, when it is not the one the
                  family follows. `/panchang` has said this all along; here it
                  matters more, because this is where the date is actually chosen.
                  Substituting silently is the failure ADR 0003 exists to prevent.
                */}
                {substituted && (
                  <p className="notice warn" style={{ margin: '0 0 14px', fontSize: '.9rem' }}>
                    Your family follows <strong>{substituted.english}</strong>, which has
                    not been transcribed for this year yet, so these dates are computed
                    from another almanac. The two differ on some tithis — worth checking
                    with your purohit for a wedding or upanayan.
                  </p>
                )}

                {/*
                  Never a blank calendar.

                  "Waiting to ask someone about a good date" is the commonest reason a
                  booking is delayed, and the panchang engine has been able to answer
                  it all along — it was rendered as a small tag on a flat strip. Now
                  the good days lead, each with the reason, and every other date is
                  one tap away because the choice stays with the devotee.
                */}
                {muhurats.length > 0 && !allDates && (
                  <>
                    <div className="muh-list">
                      {muhurats.map((m) => (
                        <button key={m.date}
                                className={`muh${day === m.date ? ' on' : ''}`}
                                aria-pressed={day === m.date}
                                onClick={() => chooseDay(m.date)}>
                          <div className="muh-when">
                            <span className="d">{fmtDate(m.date)}</span>
                            {m.hasAbhijit && m.abhijit && (
                              <span className="abh">
                                Abhijit {time(m.abhijit.startsAt)}
                              </span>
                            )}
                          </div>
                          <ul className="muh-why">
                            {m.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}
                          </ul>
                          {m.caution && <div className="muh-caution">{m.caution}</div>}
                        </button>
                      ))}
                    </div>
                    <button className="occ-skip" onClick={() => setAllDates(true)}>
                      Prefer a different day? Show all dates →
                    </button>
                  </>
                )}
                {soon && (
                  <div className="notice quiet" style={{ marginTop: 0 }}>
                    Showing the next 2 days only.{' '}
                    <button className="linkish" onClick={() => setSoon(false)}>
                      Show all 21 days
                    </button>
                  </div>
                )}
                {(muhurats.length === 0 || allDates) && (
                <div className="daystrip" role="group" aria-label="Choose a date">
                  {dayList(soon ? 2 : 21).map((d) => {
                    const p = panchang[d];
                    const good = p?.auspiciousForRitualIds.includes(ritual.id);
                    const dt = new Date(`${d}T12:00`);
                    return (
                      <button key={d} className={`daychip ${day === d ? 'on' : ''}`}
                              aria-pressed={day === d}
                              onClick={() => chooseDay(d)}>
                        <div className="dow">{dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                        <div className="d">{dt.getDate()}</div>
                        <div className="mo">{dt.toLocaleDateString('en-IN', { month: 'short' })}</div>
                        {good && <div className="aus">Auspicious</div>}
                      </button>
                    );
                  })}
                </div>
                )}
                {!day && (
                  <p className="nextcue">Pick a date to see which times are open.</p>
                )}
              </div>

              {day && (
                <>
                  {panchang[day] && (
                    <div className="panjika" style={{ margin: '20px 0' }}>
                      <div className="cols">
                        <div className="col"><span className="k">Tithi</span>
                          <span className="v">{panchang[day]!.tithiAtSunrise}</span></div>
                        <div className="col"><span className="k">Nakshatra</span>
                          <span className="v">{panchang[day]!.nakshatraAtSunrise}</span></div>
                        {panchang[day]!.abhijit && (
                          <div className="col"><span className="k">Abhijit · best</span>
                            <span className="v mono" style={{ color: 'var(--green)' }}>
                              {time(panchang[day]!.abhijit!.startsAt)}–{time(panchang[day]!.abhijit!.endsAt)}
                            </span></div>
                        )}
                        {panchang[day]!.rahuKaal && (
                          <div className="col"><span className="k">Rahu Kaal · avoid</span>
                            <span className="v mono" style={{ color: '#BE123C' }}>
                              {time(panchang[day]!.rahuKaal!.startsAt)}–{time(panchang[day]!.rahuKaal!.endsAt)}
                            </span></div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Sub-step B --------------------------------------------- */}
                  <div className="substep" ref={timeRef} style={{ scrollMarginTop: 88 }}>
                    <div className="substep-head">
                      <span className="ix">2</span>
                      <div>
                        <h3>Choose a time on {fmtDate(day)}</h3>
                        <p className="hint">
                          These are real times. The one you pick is held for you — you are
                          not waiting to be allocated.
                        </p>
                      </div>
                    </div>
                  {loadingTimes && <p className="muted">Finding available times…</p>}
                  {!loadingTimes && times.filter((t) => t.available).length === 0 && (
                    <p className="muted">
                      No purohit is free on this date for {ritual.name}. Try another day.
                    </p>
                  )}

                  {/*
                    The whole day in 30-minute steps, not four fixed slots.
                    Grouped by part of day because 48 buttons in one run cannot be
                    scanned — and the groups are the words a family actually uses.
                    Brahma muhurta and the night bands are only ever populated when
                    a purohit has opted into those hours, so an empty group simply
                    does not render.
                  */}
                  {!loadingTimes && TIME_BANDS.map((band) => {
                    const inBand = times.filter((t) => {
                      if (!t.available) return false;
                      const h = localHour(t.startsAt);
                      return h >= band.from && h < band.to;
                    });
                    if (inBand.length === 0) return null;
                    return (
                      <div className="timeband" key={band.id}>
                        <div className="timeband-head">
                          <span className="nm">{band.label}</span>
                          <span className="note">{band.note}</span>
                        </div>
                        <div className="timegrid">
                          {inBand.map((t) => {
                            const d = panchang[day];
                            const best = d?.abhijit
                              && new Date(t.startsAt) >= new Date(d.abhijit.startsAt)
                              && new Date(t.startsAt) < new Date(d.abhijit.endsAt);
                            const rahu = d?.rahuKaal
                              && overlaps(t.startsAt, t.endsAt,
                                          d.rahuKaal.startsAt, d.rahuKaal.endsAt);
                            return (
                              <button key={t.startsAt}
                                      className={[
                                        'timeslot',
                                        startsAt === t.startsAt ? 'on' : '',
                                        best ? 'best' : '',
                                      ].filter(Boolean).join(' ')}
                                      aria-pressed={startsAt === t.startsAt}
                                      onClick={() => chooseTime(t)}>
                                <span className="t">{time(t.startsAt)}</span>
                                {best && <span className="mark auspicious">Abhijit</span>}
                                {rahu && !best && <span className="mark avoid">Rahu Kaal</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <p className="muted" style={{ fontSize: '.85rem', marginTop: 10 }}>
                    Rahu Kaal is shown so you can avoid it — never blocked. The choice stays yours.
                  </p>
                  {startsAt === null && !loadingTimes && times.some((t) => t.available) && (
                    <p className="nextcue">Pick a time to see the pandits available then.</p>
                  )}
                  </div>
                </>
              )}
              </>
              )}
            </>
          )}

          {/* No pandit-selection step. The platform assigns; see ADR 0012. What
              remains is a note on availability, so an empty slot is still explained
              here rather than only at the moment of booking. */}
          {ritual && day && startsAt && !draft && searching && (
            <p className="searching" role="status" aria-live="polite"
               ref={panditRef as never} style={{ scrollMarginTop: 88 }}>
              <span className="spin" aria-hidden="true" />
              Checking who is free at {time(startsAt)}…
            </p>
          )}

          {ritual && day && startsAt && !draft && !searching && slotErr && (
            <div className="notice err">
              {slotErr}
              <div style={{ marginTop: 10 }}>
                <button className="btn outline sm" onClick={() => backTo(2)}>
                  Pick another time
                </button>
              </div>
            </div>
          )}

          {/* 3 — options + confirm */}
          {ritual && day && startsAt && !draft && !searching && !slotErr && (
            <div className="card" ref={optionsRef} style={{ marginTop: 24, scrollMarginTop: 88 }}>
              <div className="spread" style={{ marginBottom: 18 }}>
                <span className="steplabel">Step 3 of 3</span>
              </div>

              {/* Says what will happen, without asking the devotee to arbitrate
                  between names they have no way to compare. */}
              <div className="notice quiet" style={{ marginTop: 0 }}>
                <strong>{pandits.length > 1
                  ? `${pandits.length} pandits are free at this time.`
                  : 'A pandit is free at this time.'}</strong>{' '}
                We will assign the best match for your family&apos;s vidhi and language,
                nearest to you — and tell you who, before you pay.
              </div>
              {/* Where. Skipped for a video call — there is no venue. */}
              {!virtual && (
                <>
                  <h3 style={{ marginBottom: 12 }}>Where should the pandit come?</h3>
                  <div className="addr-list">
                    {addresses.map((a) => (
                      <button key={a.id} type="button"
                              className={`addr ${addressId === a.id ? 'on' : ''}`}
                              aria-pressed={addressId === a.id}
                              onClick={() => { setAddressId(a.id); setAddingAddress(false); }}>
                        <span className="lb">{a.label ?? 'Home'}</span>
                        <span className="ln">
                          {/*
                            `a.city`, not `region.name.en`. This showed whichever
                            city was selected in the HEADER against every saved
                            address, so a devotee with a flat in Kolkata and parents
                            in Delhi saw both labelled the same — and the label
                            changed when they switched city, without the address
                            having moved.
                          */}
                          {a.line1}{a.line2 ? `, ${a.line2}` : ''} · {a.city} {a.pincode}
                        </span>
                      </button>
                    ))}

                    {!addingAddress && (
                      <button type="button" className="addr add"
                              onClick={() => setAddingAddress(true)}>
                        + Add a new address
                      </button>
                    )}
                  </div>

                  {addingAddress && (
                    <AddressForm
                      idPrefix="addr"
                      onSaved={(saved) => {
                        setAddresses((a) => [saved, ...a]);
                        setAddressId(saved.id);
                        setAddingAddress(false);
                      }}
                      /* A devotee with no address saved has nothing to go back
                         to, so there is no Cancel to offer them. */
                      onCancel={addresses.length > 0 ? () => setAddingAddress(false) : undefined}
                    />
                  )}
                </>
              )}

              {myPhone && (
                <p className="faint" style={{ fontSize: '.86rem', margin: '0 0 20px' }}>
                  Confirmation and your start and completion codes go to{' '}
                  <strong>{myPhone}</strong> on WhatsApp.{' '}
                  <Link href="/account?tab=profile">Change number</Link>
                </p>
              )}

              {/*
                Materials, but only where there is a choice to make.

                This chooser rendered for EVERY booking, so someone booking a video
                consultation was offered "Pandit brings everything — itemised at
                catalogue rates". Over a video call. A purohit joining remotely
                cannot carry anything, so for a virtual booking there is no decision
                here: either the rite needs nothing (a consultation) or the devotee
                keeps a few things ready at their own end (an online aarti), and
                either way `samagriOption` is `'none'` and the line is ₹0.
              */}
              {!virtual ? (
                <>
                  <h3 style={{ margin: '26px 0 12px' }}>Pooja materials</h3>
                  <div className="opt-row" style={{ marginBottom: 22 }}>
                    <button className={`opt ${samagri === 'pandit_brings' ? 'on' : ''}`}
                            onClick={() => setSamagri('pandit_brings')}>
                      Pandit brings everything
                      <span className="s">
                        {ritual.bomTotalPaise > 0
                          ? `${money(Math.round(ritual.bomTotalPaise * 1.05))} · itemised at catalogue rates`
                          : 'Itemised at catalogue rates'}
                      </span>
                    </button>
                    <button className={`opt ${samagri === 'none' ? 'on' : ''}`}
                            onClick={() => setSamagri('none')}>
                      I&apos;ll arrange materials
                      <span className="s">Nothing to pay here · checklist in advance</span>
                    </button>
                  </div>
                </>
              ) : (ritual.bomItemCount ?? 0) > 0 ? (
                <div className="incl">
                  <h3 style={{ margin: '26px 0 6px' }}>Keep these ready at your end</h3>
                  <p className="muted" style={{ fontSize: '.88rem', margin: '0 0 10px' }}>
                    The purohit joins by video, so nothing is delivered. We send the
                    full list again the day before. Nothing to pay here.
                  </p>
                  <Link href={`/pooja/${ritual.slug}`} className="incl-link">
                    See the full list
                  </Link>
                </div>
              ) : (
                <div className="incl">
                  <h3 style={{ margin: '26px 0 6px' }}>What&apos;s included</h3>
                  <ul className="ticks" style={{ margin: 0 }}>
                    <li>A private video call for {ritual.durationMin} minutes</li>
                    <li>An experienced purohit who answers in your language</li>
                    <li>Nothing to arrange and nothing to buy</li>
                  </ul>
                </div>
              )}

              {/*
                Cash cannot change hands over a video call.
                
                The same conflation as the materials chooser: a remote booking was
                offered "Cash to the pandit" and then told, on the very next line,
                that ₹1,100 was due "to the pandit on the day" — for a puja with no
                day and no doorstep. Online is the only way a virtual booking can
                settle, so it is stated rather than chosen.
              */}
              <h3 style={{ marginBottom: 12 }}>How would you like to pay?</h3>
              {virtual ? (
                <p className="muted" style={{ fontSize: '.9rem', margin: '0 0 22px' }}>
                  Paid online when you book — there is no doorstep to settle at.
                </p>
              ) : (
                <div className="opt-row" style={{ marginBottom: 22 }}>
                  <button className={`opt ${payment === 'cash' ? 'on' : ''}`}
                          onClick={() => setPayment('cash')}>
                    Cash to the pandit
                    <span className="s">Small booking amount online now</span>
                  </button>
                  <button className={`opt ${payment === 'digital_full' ? 'on' : ''}`}
                          onClick={() => setPayment('digital_full')}>
                    Pay fully online
                    <span className="s">3% lower commission</span>
                  </button>
                </div>
              )}

              {/*
                What each choice actually costs, at the moment it is made.

                The split existed only on the NEXT screen, after "Review and book",
                so the devotee chose between cash and online blind — and the online
                option's own label promises "3% lower commission" without showing
                the rupees. Computed with the same `computePrice` the API uses, so
                it cannot disagree with the bill that follows.
              */}
              {quote && (
                <div className="paysplit">
                  <div className="line now">
                    <span>Pay online now</span>
                    <span>{money(quote.tokenPaise)}</span>
                  </div>
                  {/*
                    Only when something is actually left to pay. `digital_full` now
                    charges the whole total up front, so this line rendered
                    "Charged when the puja is done — ₹0", which reads as a broken
                    figure rather than as nothing owed.
                  */}
                  {quote.balancePaise > 0 && (
                    <div className="line due">
                      <span>
                        {effectivePayment === 'cash'
                          ? 'Cash to the pandit on the day'
                          : 'Charged when the puja is done'}
                      </span>
                      <span>{money(quote.balancePaise)}</span>
                    </div>
                  )}
                </div>
              )}

              {/*
                Stated before the commitment, not after it. Cancellation terms are
                an input to the decision — a family booking months ahead for a
                wedding is weighing exactly this — and they appeared only on the
                confirmation screen, once the choice had been made.
              */}
              <p className="faint" style={{ fontSize: '.84rem', margin: '0 0 14px' }}>
                Free cancellation up to 48 hours before. Inside 48 hours the booking
                amount is retained. If the pandit cancels you are refunded in full,
                whatever the notice. <Link href="/terms">Read the full policy</Link>.
              </p>

              {/* Beside the button, not in a banner at the top of a page the user
                  has already scrolled past. "Review and book" appeared to do
                  nothing because the failure was rendered off-screen. */}
              {err && <div className="notice err" style={{ marginTop: 0 }}>{err}</div>}

              <button className="btn-block" onClick={book} disabled={busy}>
                {busy ? 'Working…' : signedIn ? 'Review and book' : 'Sign in to book'}
              </button>
              {!signedIn && (
                <p className="muted" style={{ fontSize: '.85rem', margin: '10px 0 0', textAlign: 'center' }}>
                  Your selection is kept — you will come straight back here.
                </p>
              )}
            </div>
          )}

          {/* confirmation */}
          {draft && price && (
            <div className="card">
              <h3 style={{ marginBottom: 14 }}>Your booking</h3>
              <div className="bill">
                <div className="line"><span>Dakshina</span><span>{money(price.dakshinaPaise)}</span></div>
                {price.samagriPaise > 0 && (
                  <div className="line"><span>Pooja materials</span><span>{money(price.samagriPaise)}</span></div>
                )}
                {price.travelPaise > 0 && (
                  <div className="line"><span>Travel</span><span>{money(price.travelPaise)}</span></div>
                )}
                <div className="line"><span>Service fee · {price.commissionBps / 100}%</span>
                  <span>{money(price.platformFeePaise)}</span></div>
                <div className="line total">
                  <span>Total</span>
                  <span className="amt">{money(price.totalPaise)}</span>
                </div>
                <div className="pay-split">
                  {/*
                    Hidden at zero. On a cash-only deployment the token is nothing,
                    and "Pay online now ₹0" is a line about a payment that does not
                    exist — the balance line below already says the whole amount is
                    cash on the day. The symmetric `balancePaise > 0` guard was
                    always here; this side was missing it because, with a gateway,
                    the token is never zero.
                  */}
                  {price.tokenPaise > 0 && (
                    <div className="line now">
                      <span>Pay online now</span>
                      <span>{money(price.tokenPaise)}</span>
                    </div>
                  )}
                  {price.balancePaise > 0 && (
                    <div className="line due">
                      <span>{effectivePayment === 'cash' ? 'Cash to pandit on the day' : 'Charged on completion'}</span>
                      <span>{money(price.balancePaise)}</span>
                    </div>
                  )}
                </div>
                <p className="note">
                  {/*
                    There is no door on a video call, and nothing to negotiate at it:
                    a virtual booking is `digital_full`, so the balance is charged
                    rather than handed over. This sentence was shown on every booking
                    regardless, telling someone paying online for an Online Aarti that
                    their cash amount was fixed.
                  */}
                  {effectivePayment === 'cash'
                    ? 'The cash amount is fixed now, so nothing is negotiated at your door. '
                    : 'The full amount is fixed now — nothing further is collected on the day. '}
                  Cancel more than 48 hours ahead for a full refund; if the pandit cancels,
                  you are refunded in full whatever the notice.
                </p>
              </div>

              {!otps ? (
                <>
                  {/* This used to say "they have two hours to accept" and then offer
                      a Pay button that threw until they did. The slot is held on
                      payment now — nobody else has to say yes first. */}
                  {/* The devotee does not choose, but they are always TOLD. A
                      stranger coming to your home on a named day is not an
                      anonymous transaction. */}
                  <div className="assigned">
                    {/*
                      Their face, not the first letter of their name.

                      `photoUrl` has been on this contract since the first commit with
                      null hardcoded into it, so this rendered an initial in a circle —
                      and since ADR 0012 the devotee did not choose this person, so that
                      initial was the whole of what they saw before the door opened.
                    */}
                    {draft.pandit?.photoUrl
                      ? <img className="avatar" src={draft.pandit.photoUrl} alt="" />
                      : (
                        <div className="avatar" aria-hidden="true">
                          {(draft.pandit?.name ?? 'P').trim().charAt(0).toUpperCase()}
                        </div>
                      )}
                    <div>
                      <div className="who">{draft.pandit?.name ?? 'Your pandit'}</div>
                      <div className="why">
                        {draft.pandit?.experienceYears
                          ? `${draft.pandit.experienceYears} years · `
                          : ''}
                        matched for your vidhi and language, nearest to you
                      </div>
                    </div>
                  </div>

                  {/*
                    Hear him before you pay.
                    Families judge shuddha uchcharan, and no site in this category
                    lets them listen. It matters most right here, because the
                    devotee did not choose this person — we did.
                  */}
                  {draft.pandit?.chantingSampleUrl && (
                    <div className="chant">
                      <div className="chant-head">
                        Hear {draft.pandit.name.split(' ')[0]} recite
                        {draft.pandit.chantingSampleLabel
                          ? ` — ${draft.pandit.chantingSampleLabel}` : ''}
                      </div>
                      <audio controls preload="none" src={draft.pandit.chantingSampleUrl}>
                        Your browser cannot play audio.
                      </audio>
                    </div>
                  )}
                  <div className="notice ok">
                    Held for {fmtDate(day)}, {time(startsAt!)}. Pay the booking
                    amount to lock it in.
                  </div>
                  {err && <div className="notice err" style={{ marginTop: 0 }}>{err}</div>}
                  <button className="btn-block" onClick={pay} disabled={busy}>
                    {busy ? 'Working…' : `Pay ${money(price.tokenPaise)} to confirm`}
                  </button>
                </>
              ) : (
                <>
                  <div className="notice ok">Confirmed. Your booking is set.</div>
                  {/*
                    The codes are only ever returned by the local dev shortcut. On a
                    real payment we store their hashes and send the codes to the
                    devotee's phone, so there is nothing to print here — and printing
                    two empty boxes, as this did, would leave them hunting for a
                    number that was never on the screen.
                  */}
                  {otps.startOtp ? (
                    <>
                      <p style={{ fontSize: '.95rem' }}>
                        {/*
                          Same fix as the note above: "handed over the cash" is wrong
                          on anything but a cash booking, and an Online Aarti is
                          always `digital_full` — there is no cash and no doorstep.
                        */}
                        Give these codes to the pandit — the first to begin, the second when the
                        ritual is done
                        {effectivePayment === 'cash' ? ' and you have handed over the cash.' : '.'}
                      </p>
                      <div className="row">
                        <div className="card quiet" style={{ padding: 14 }}>
                          <div className="muted" style={{ fontSize: '.78rem' }}>Start code</div>
                          <div className="mono" style={{ fontSize: '1.6rem', fontWeight: 800 }}>{otps.startOtp}</div>
                        </div>
                        <div className="card quiet" style={{ padding: 14 }}>
                          <div className="muted" style={{ fontSize: '.78rem' }}>Completion code</div>
                          <div className="mono" style={{ fontSize: '1.6rem', fontWeight: 800 }}>{otps.completeOtp}</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p style={{ fontSize: '.95rem' }}>
                      We have sent two codes to your phone — give the pandit the first
                      to begin, and the second once the ritual is done. You will find
                      them again under My bookings.
                    </p>
                  )}
                  <button className="outline btn-block" style={{ marginTop: 16 }} onClick={reset}>
                    Book another
                  </button>
                  {/*
                    This page's job is starting a booking, not tracking every
                    booking the devotee has ever made - that was a plain,
                    unfiltered, read-only dump of the full history sitting below
                    the flow, duplicating /account (which groups upcoming/past
                    and actually lets you cancel). One link out, where the
                    devotee's attention already is at the moment they'd want it.
                  */}
                  <Link href="/account" className="linkish"
                        style={{ display: 'block', textAlign: 'center', marginTop: 14 }}>
                    View your bookings →
                  </Link>
                </>
              )}
            </div>
          )}
        </div>

        {/* -------------------------------------------------- order summary */}
        <aside className="summary">
          <div className="card">
            <div className="head">Booking summary</div>
            {!ritual && <div className="empty">Choose a service to get started.</div>}
            {ritual && (
              <>
                <div className="lineitem"><span className="k">Service</span><span>{ritual.name}</span></div>
                <div className="lineitem"><span className="k">City</span><span>{region.name.en}</span></div>
                {day && <div className="lineitem"><span className="k">Date</span><span>{fmtDate(day)}</span></div>}
                {startsAt && (
                  <div className="lineitem"><span className="k">Time</span><span>{time(startsAt)}</span></div>
                )}
                <div className="lineitem"><span className="k">Pandit</span>
                  <span>{draft?.pandit?.name ?? 'Assigned on booking'}</span></div>
                {/* "Pandit brings" is not a thing that can happen on a video call. */}
                {!virtual && (
                  <div className="lineitem"><span className="k">Materials</span>
                    <span>{samagri === 'pandit_brings' ? 'Pandit brings' : 'You arrange'}</span></div>
                )}
                <div className="lineitem" style={{ borderTop: '1px solid var(--line)', marginTop: 8, paddingTop: 12 }}>
                  <span className="k">{price ? 'Total' : 'Estimated total'}</span>
                  <strong style={{ fontSize: '1.15rem' }}>{money(price?.totalPaise ?? estimate)}</strong>
                </div>
                {!price && (
                  <p className="faint" style={{ fontSize: '.8rem', margin: '10px 0 0' }}>
                    Final price is itemised before you pay.
                  </p>
                )}
                {!draft && (
                  <p className="nextcue" style={{ marginTop: 14 }}>
                    {!day ? 'Next: choose a date'
                      : !startsAt ? 'Next: choose a time'
                      : searching ? 'Checking availability…'
                      : 'Next: confirm materials and payment'}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="card quiet" style={{ marginTop: 14, fontSize: '.86rem' }}>
            <strong>Why book here</strong>
            <ul style={{ paddingLeft: '1.1rem', margin: '8px 0 0', color: 'var(--muted)' }}>
              <li>Real slot, held the moment you pay</li>
              <li>Itemised bill, no package pricing</li>
              <li>Full refund if the pandit cancels</li>
            </ul>
          </div>
        </aside>
      </div>

      {/* On a phone the summary card is far below the fold, so the running total and
          the next action follow the user down the page. */}
      {ritual && !draft && (
        <div className="mobile-cta show">
          <div className="amt">
            {money(price?.totalPaise ?? estimate)}
            {/*
              This read off a piece of state (`pandit`, singular) that was never
              actually set anywhere - leftover from before ADR 0012 removed
              pandit-selection - so the label always said "from", even once a
              real, confirmed-available match existed for this slot. `pandits`
              (plural) is the actual signal for that: non-empty once a search has
              come back with someone free at this exact date and time.
            */}
            <small>{pandits.length > 0 ? 'estimated total' : 'from'}</small>
          </div>
          {/* The button was disabled until a pandit was picked, so on a phone the one
              visible control did nothing for the first three steps. Now it always
              moves you to whatever is outstanding.
              It used to say "Review and book" and fire `book()` even when the
              search had just come back with `slotErr` set (no pandit free, or the
              search itself failed) - so tapping the one visible control on a phone
              silently repeated a request already known to fail, instead of showing
              the explanation already sitting on screen above it. */}
          <button className="btn-block" disabled={busy}
                  onClick={() => {
                    if (!day) return revealNext(document.querySelector('.daystrip'));
                    if (!startsAt) return revealNext(timeRef.current);
                    if (slotErr) return revealNext(document.querySelector('.notice.err'));
                    void book();
                  }}>
            {!day ? 'Choose a date' : !startsAt ? 'Choose a time'
              : searching ? 'Checking availability…'
              : slotErr ? 'See what went wrong'
              : signedIn ? 'Review and book' : 'Sign in to book'}
          </button>
        </div>
      )}

    </div>
  );
}

export default function BookPage() {
  return <Suspense fallback={null}><BookInner /></Suspense>;
}
