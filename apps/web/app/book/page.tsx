'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { dayList } from '@/lib/format';
import { PanjikaPrompt } from '../panjika-prompt';
import { OccasionPicker } from '@/components/occasion-picker';
import { ServiceCardSkeletons } from '@/components/skeletons';
import { getCollection } from '@/lib/collections';
import { bestMuhurats } from '@themaithil/region';

interface Ritual {
  id: string; slug: string; name: string; shortDescription: string;
  durationMin: number; defaultSlotSpan: number; bomTotalPaise: number;
  deliveryMode: 'at_home' | 'virtual';
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
interface Address {
  id: string; label: string | null; line1: string; line2: string | null;
  pincode: string;
}

const EMOJI: Record<string, string> = {
  'griha-prabesh': '🏠', 'biye': '💒', 'satyanarayan-puja': '📿', 'rudrabhishek': '🔱',
  'annaprashan': '🍚', 'upanayan': '🧵', 'durga-puja-ghot': '🪔', 'kali-puja': '🌺',
  'lakshmi-puja': '🪙', 'saraswati-puja': '📖', 'ganesh-puja': '🐘', 'bastu-puja': '🧭',
  'nabagraha-shanti': '🪐', 'sraddha': '🙏', 'tarpan': '💧', 'halkhata': '📕',
};
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
  const { region, money, time, date: fmtDate, slotLabel } = useRegion();

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
  const [slotIdx, setSlotIdx] = useState<number | null>(null);
  const [pandits, setPandits] = useState<Purohit[]>([]);
  const [samagri, setSamagri] = useState<'pandit_brings' | 'none'>('pandit_brings');
  const [payment, setPayment] = useState<'cash' | 'digital_full'>('cash');

  const [draft, setDraft] = useState<{
    id: string; price: Price;
    pandit?: {
      id: string; name: string; experienceYears: number;
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
  const [newAddress, setNewAddress] = useState({
    label: 'Home', line1: '', line2: '', pincode: '',
  });

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
    api<{ panjikaSchool: string | null }>('/v1/auth/me')
      .then((me) => setNeedsPanjika(me.panjikaSchool === null && region.panjikas.length > 1))
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
    api<Ritual[]>(`/v1/rituals?${qs}`, { auth: false })
      .then(setRituals).catch(() => setRituals([]))
      .finally(() => setLoadingCatalogue(false));

    api<typeof categories>(`/v1/categories?citySlug=${region.slug}`, { auth: false })
      .then(setCategories)
      .catch((e) => setErr(`Categories unavailable: ${(e as Error).message}`));
    const days = dayList(21);
    api<PanchangDay[]>(
      `/v1/panchang?citySlug=${region.slug}&from=${days[0]}&to=${days.at(-1)}`
      + `&school=${region.defaultPanjika}&locale=en`, { auth: false },
    ).then((l) => setPanchang(Object.fromEntries(l.map((d) => [d.date, d])))).catch(() => {});
  }, [region.slug, region.defaultPanjika, category]);

  // Resume an interrupted booking once the catalogue has loaded.
  useEffect(() => {
    if (!signedIn || rituals.length === 0 || ritual) return;
    const raw = sessionStorage.getItem('themaithil.pending');
    if (!raw) return;
    sessionStorage.removeItem('themaithil.pending');
    try {
      const p = JSON.parse(raw) as {
        ritualId: string; date: string; slotIdx: number;
        samagri: 'pandit_brings' | 'none'; payment: 'cash' | 'digital_full';
      };
      const r = rituals.find((x) => x.id === p.ritualId);
      if (!r) return;
      setRitual(r); setDay(p.date); setSlotIdx(p.slotIdx);
      setSamagri(p.samagri); setPayment(p.payment);
      void api<{ results: Purohit[] }>(
        `/v1/search/pandits?citySlug=${region.slug}&ritualId=${p.ritualId}`
        + `&date=${p.date}&slotIdx=${p.slotIdx}`, { auth: false },
      ).then((res) => {
        setPandits(res.results);
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

  const step = !ritual ? 1 : slotIdx === null ? 2 : 3;
  const virtual = ritual?.deliveryMode === 'virtual';
  const shown = useMemo(() => {
    // The collection narrows first, so a search inside "New and noteworthy"
    // searches that shelf rather than silently escaping to the whole catalogue.
    const base = collection ? collection.select(rituals) as Ritual[] : rituals;
    const n = q.trim().toLowerCase();
    return n ? base.filter((r) => r.name.toLowerCase().includes(n)
      || r.shortDescription.toLowerCase().includes(n)) : base;
  }, [rituals, q, collection]);

  const findPandits = useCallback(async (d: string, s: number, r: Ritual) => {
    setErr(null); setSlotErr(null); setPandits([]); setSearching(true);
    try {
      const res = await api<{ results: Purohit[] }>(
        `/v1/search/pandits?citySlug=${region.slug}&ritualId=${r.id}&date=${d}&slotIdx=${s}`,
        { auth: false });
      setPandits(res.results);
      // A "no results" message belongs beside the slots that produced it, not in a
      // banner at the top of the page where the user is no longer looking.
      if (res.results.length === 0) {
        setSlotErr('No pandit is free in that slot. Try another time or another date.');
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
    setDay(d); setSlotIdx(null); setPandits([]); setSlotErr(null);
    requestAnimationFrame(() => revealNext(timeRef.current));
  };

  const chooseSlot = (s: number) => {
    if (!ritual) return;
    setSlotIdx(s);
    requestAnimationFrame(() => revealNext(panditRef.current));
    void findPandits(day, s, ritual);
  };

  const saveAddress = async () => {
    setBusy(true); setErr(null);
    try {
      const saved = await api<Address>('/v1/me/addresses', {
        method: 'POST',
        body: JSON.stringify({
          label: newAddress.label.trim() || 'Home',
          line1: newAddress.line1.trim(),
          line2: newAddress.line2.trim() || undefined,
          citySlug: region.slug,
          pincode: newAddress.pincode.trim(),
        }),
      });
      setAddresses((a) => [saved, ...a]);
      setAddressId(saved.id);
      setAddingAddress(false);
      setNewAddress({ label: 'Home', line1: '', line2: '', pincode: '' });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const book = async () => {
    if (!ritual || slotIdx === null) return;
    if (!auth.token) {
      // Keep the whole selection so the flow resumes exactly here after signing in.
      sessionStorage.setItem('themaithil.pending', JSON.stringify({
        ritualId: ritual.id, date: day, slotIdx, samagri, payment,
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
          date: day, slotIdx, samagriOption: samagri, paymentMode: payment, attendeeCount: 20,
        }),
      });
      setDraft(created);
      await api(`/v1/bookings/${created.id}/submit`, { method: 'POST' });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const pay = async () => {
    if (!draft) return;
    setBusy(true); setErr(null);
    try {
      // Was swallowing the real error and replacing it with "the pandit has not
      // accepted yet", which was both the wrong advice and — after auto-accept —
      // no longer even a possible cause.
      await api(`/v1/bookings/${draft.id}/payment-intent`, { method: 'POST' });
      const r = await api<{ startOtp?: string; completeOtp?: string }>(
        `/v1/dev/bookings/${draft.id}/simulate-token-capture`, { method: 'POST' });
      setOtps(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const reset = () => {
    consumedRitual.current = true;
    setRitual(null); setDay(''); setSlotIdx(null);
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
    if (target <= 2) { setSlotIdx(null); }
    if (target <= 1) reset();
  };

  if (needsPanjika) {
    return <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <PanjikaPrompt onDone={() => setNeedsPanjika(false)} />
    </div>;
  }

  const estimate = ritual
    ? Math.round(((ritual.priceBand.defaultPaise)
        + (samagri === 'pandit_brings' ? ritual.bomTotalPaise * 1.05 : 0)) * 1.15)
    : 0;
  const price = draft?.price;

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
                      <span aria-hidden="true">{c.emoji}</span> {c.en}
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
                  <div style={{ fontSize: 34 }}>🔍</div>
                  <h3 style={{ margin: '10px 0 6px' }}>
                    {q || category ? 'No services match those filters' : 'Services could not be loaded'}
                  </h3>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {q || category
                      ? 'Try a different word, or clear the filters to see everything.'
                      : 'Check that the API is running on port 3000, then refresh.'}
                  </p>
                </div>
              )}

              <div className="grid svc">
                {shown.map((r) => (
                  <div key={r.id} className="svc-card">
                    <div className="svc-top">
                      <div className="emoji">{EMOJI[r.slug] ?? '🕉️'}</div>
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
                  <div>
                    <span className="steplabel">Step 1 · chosen</span>
                    <div style={{ fontWeight: 700 }}>{EMOJI[ritual.slug] ?? '🕉️'} {ritual.name}</div>
                    <div className="muted" style={{ fontSize: '.9rem' }}>
                      {ritual.durationMin} minutes
                      {ritual.defaultSlotSpan > 1 && ` · needs ${ritual.defaultSlotSpan} slots`}
                    </div>
                  </div>
                  <button className="btn outline sm" onClick={reset}>Change service</button>
                </div>
              </div>

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
                    <span className="faint scroll-hint">scroll for more →</span>
                  )}
                </div>

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
                          These are real slots. The one you pick is held for you — you are
                          not waiting to be allocated.
                        </p>
                      </div>
                    </div>
                  <div className="slotgrid"
                       style={{ gridTemplateColumns: `repeat(${Math.min(region.slots.length, 4)}, 1fr)` }}>
                    {region.slots.map((s) => {
                      const d = panchang[day];
                      const start = `${day}T${s.start}:00+05:30`;
                      const end = `${day}T${s.end}:00+05:30`;
                      const best = d?.abhijit
                        && new Date(d.abhijit.startsAt) >= new Date(start)
                        && new Date(d.abhijit.endsAt) <= new Date(end);
                      const rahu = d?.rahuKaal
                        && overlaps(start, end, d.rahuKaal.startsAt, d.rahuKaal.endsAt);
                      const fits = s.idx + ritual.defaultSlotSpan <= region.slots.length;
                      return (
                        <button key={s.idx} className={`slot ${slotIdx === s.idx ? 'on' : ''}`}
                                disabled={!fits} aria-pressed={slotIdx === s.idx}
                                onClick={() => chooseSlot(s.idx)}>
                          {slotLabel(s.idx)}
                          {best && <span className="mark auspicious">Abhijit</span>}
                          {rahu && !best && <span className="mark avoid">Rahu Kaal</span>}
                        </button>
                      );
                    })}
                  </div>
                  <p className="muted" style={{ fontSize: '.85rem', marginTop: 10 }}>
                    Rahu Kaal is shown so you can avoid it — never blocked. The choice stays yours.
                  </p>
                  {slotIdx === null && (
                    <p className="nextcue">Pick a time to see the pandits available then.</p>
                  )}
                  </div>
                </>
              )}
            </>
          )}

          {/* No pandit-selection step. The platform assigns; see ADR 0012. What
              remains is a note on availability, so an empty slot is still explained
              here rather than only at the moment of booking. */}
          {ritual && day && slotIdx !== null && !draft && searching && (
            <p className="searching" role="status" aria-live="polite"
               ref={panditRef as never} style={{ scrollMarginTop: 88 }}>
              <span className="spin" aria-hidden="true" />
              Checking who is free at {slotLabel(slotIdx)}…
            </p>
          )}

          {ritual && day && slotIdx !== null && !draft && !searching && slotErr && (
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
          {ritual && day && slotIdx !== null && !draft && !searching && !slotErr && (
            <div className="card" ref={optionsRef} style={{ marginTop: 24, scrollMarginTop: 88 }}>
              <div className="spread" style={{ marginBottom: 18 }}>
                <span className="steplabel">Step 3 of 3</span>
                <button className="btn outline sm" onClick={() => backTo(2)}>Change time</button>
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
                          {a.line1}{a.line2 ? `, ${a.line2}` : ''} · {region.name.en} {a.pincode}
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
                    <div className="addr-form">
                      <div className="field">
                        <label htmlFor="addr-label">Label</label>
                        <input id="addr-label" value={newAddress.label}
                               placeholder="Home, Office, Ma's place"
                               onChange={(e) => setNewAddress((n) => ({ ...n, label: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label htmlFor="addr-line1">Flat, building, street</label>
                        <input id="addr-line1" value={newAddress.line1}
                               placeholder="12 Hindusthan Park"
                               onChange={(e) => setNewAddress((n) => ({ ...n, line1: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label htmlFor="addr-line2">Area or landmark</label>
                        <input id="addr-line2" value={newAddress.line2}
                               placeholder="Gariahat"
                               onChange={(e) => setNewAddress((n) => ({ ...n, line2: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label htmlFor="addr-pin">Pincode</label>
                        <input id="addr-pin" value={newAddress.pincode} inputMode="numeric"
                               maxLength={6} placeholder="700029"
                               onChange={(e) => setNewAddress((n) => ({ ...n, pincode: e.target.value }))} />
                      </div>
                      <p className="faint" style={{ fontSize: '.82rem', margin: '0 0 12px' }}>
                        Saving to {region.name.en}. Change your city in the header if that is wrong.
                      </p>
                      <div className="row">
                        <button className="btn" disabled={busy} onClick={saveAddress}>
                          {busy ? 'Saving…' : 'Save address'}
                        </button>
                        {addresses.length > 0 && (
                          <button className="btn outline" onClick={() => setAddingAddress(false)}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              <h3 style={{ marginBottom: 12, marginTop: virtual ? 0 : 26 }}>Pooja materials</h3>
              <div className="opt-row" style={{ marginBottom: 22 }}>
                <button className={`opt ${samagri === 'pandit_brings' ? 'on' : ''}`}
                        onClick={() => setSamagri('pandit_brings')}>
                  Pandit brings everything
                  <span className="s">Itemised at catalogue rates</span>
                </button>
                <button className={`opt ${samagri === 'none' ? 'on' : ''}`}
                        onClick={() => setSamagri('none')}>
                  I&apos;ll arrange materials
                  <span className="s">You get the checklist in advance</span>
                </button>
              </div>

              <h3 style={{ marginBottom: 12 }}>How would you like to pay?</h3>
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
                <div className="line total"><span>Total</span><span>{money(price.totalPaise)}</span></div>
                <div className="line now"><span>Pay online now</span><span>{money(price.tokenPaise)}</span></div>
                <div className="line">
                  <span>{payment === 'cash' ? 'Cash to pandit on the day' : 'Charged on completion'}</span>
                  <span>{money(price.balancePaise)}</span>
                </div>
                <p className="note">
                  The cash amount is fixed now, so nothing is negotiated at your door.
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
                    <div className="avatar" aria-hidden="true">
                      {(draft.pandit?.name ?? 'P').trim().charAt(0).toUpperCase()}
                    </div>
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
                    Held for {fmtDate(day)}, {slotLabel(slotIdx!)}. Pay the booking
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
                  <p style={{ fontSize: '.95rem' }}>
                    Give these codes to the pandit — the first to begin, the second when the
                    ritual is done and you have handed over the cash.
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
                {slotIdx !== null && (
                  <div className="lineitem"><span className="k">Time</span><span>{slotLabel(slotIdx)}</span></div>
                )}
                <div className="lineitem"><span className="k">Pandit</span>
                  <span>{draft?.pandit?.name ?? 'Assigned on booking'}</span></div>
                <div className="lineitem"><span className="k">Materials</span>
                  <span>{samagri === 'pandit_brings' ? 'Pandit brings' : 'You arrange'}</span></div>
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
                      : slotIdx === null ? 'Next: choose a time'
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
                    if (slotIdx === null) return revealNext(timeRef.current);
                    if (slotErr) return revealNext(document.querySelector('.notice.err'));
                    void book();
                  }}>
            {!day ? 'Choose a date' : slotIdx === null ? 'Choose a time'
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
