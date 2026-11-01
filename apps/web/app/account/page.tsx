'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { api, auth, idemKey } from '@/lib/api';
import { payForBooking } from '@/lib/checkout';
import { useRegion } from '@/lib/region-context';
import { STATE_LABEL, stateLabel, todayIso } from '@/lib/format';
import { Modal } from '@/components/modal';
import { AddressForm } from '@/components/address-form';
import { whatsappLink, PHONE_DISPLAY, PHONE_HREF } from '@/lib/contact';

interface Me {
  id: string; phone: string; name: string; role: string;
  locale: string; panjikaSchool: string | null;
}
interface Address {
  id: string; label: string | null; line1: string; line2: string | null;
  city: string; pincode: string;
}
interface Booking {
  id: string; state: string; date: string; slotIdx: number; slotSpan: number;
  ritualName: string | null; ritualSlug: string; paymentMode: string;
  price: { totalPaise: number; tokenPaise: number; balancePaise: number };
  panditName: string | null; panditPhone: string; panditId: string; deliveryMode: string;
  /** The window actually booked. `slotIdx` is vestigial bookkeeping — ADR 0013. */
  slotStartAt: string;
  slotEndAt: string;
}
interface DaySlots {
  date: string;
  slots: { slotIdx: number; status: string }[];
}
interface FullPrice {
  dakshinaPaise: number; samagriPaise: number; travelPaise: number;
  platformFeePaise: number; discountPaise: number; totalPaise: number;
  tokenPaise: number; balancePaise: number; commissionBps: number;
}
interface TimelineEvent {
  id: string; toState: string; trigger: string; actorRole: string | null; at: string;
}
interface PanditProfile {
  experienceYears: number; languages: string[]; traditions: string[];
  chantingSampleUrl: string | null; chantingSampleLabel: string | null;
}
interface Venue {
  label: string | null; line1: string; line2: string | null;
  pincode: string; lat: number; lng: number;
}
interface BookingDetail extends Booking {
  price: FullPrice;
  timeline: TimelineEvent[];
  panditProfile: PanditProfile | null;
  cashCollectedPaise: number | null;
  myReviewSubmitted: boolean;
  venue: Venue | null;
  /** Set by the purohit on a remote booking; null on an at-home puja. */
  joinUrl: string | null;
  recordingUrl: string | null;
}

/**
 * What this booking needs from the devotee NEXT, in one sentence.
 *
 * The detail view listed facts — a status word, a price, a timeline — and left
 * the reader to work out what any of it meant for them. "Confirmed" does not
 * tell a family whether someone is coming, whether they owe anything, or what to
 * have ready. Every state now answers that in its own words.
 */
function nextStep(state: string, paymentMode: string, virtual: boolean): {
  tone: 'do' | 'wait' | 'done'; text: string;
} | null {
  switch (state) {
    case 'draft':
    case 'pending_accept':
      return {
        tone: 'do',
        text: 'Your slot is held but not yet confirmed. Pay the booking amount to lock it in.',
      };
    case 'confirmed':
      return {
        tone: 'wait',
        text: virtual
          ? 'Confirmed. We will send your joining link on WhatsApp before the ceremony.'
          : paymentMode === 'cash'
            ? 'Confirmed. Keep the balance ready in cash, and your purohit will arrive at the start of the slot.'
            : 'Confirmed. Your purohit will arrive at the start of the slot.',
      };
    case 'in_progress':
      return { tone: 'wait', text: 'The ceremony is under way.' };
    case 'completed':
      return { tone: 'done', text: 'Completed. Your rating helps the next family choose.' };
    case 'reviewed':
      return { tone: 'done', text: 'Completed.' };
    case 'cancelled_devotee':
      return { tone: 'done', text: 'You cancelled this booking. Any refund due is returned to the original payment method.' };
    case 'cancelled_pandit':
      return { tone: 'do', text: 'Your purohit released this booking. If we could not find a replacement, you have been refunded in full.' };
    case 'expired':
      return { tone: 'done', text: 'This booking expired before it was confirmed.' };
    default:
      return null;
  }
}

const TABS = [
  { id: 'bookings', label: 'My bookings' },
  { id: 'profile', label: 'Profile' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'preferences', label: 'Preferences' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Anything not yet performed is "upcoming"; the rest is history. */
const LIVE = new Set(['draft', 'pending_accept', 'confirmed', 'in_progress']);

/**
 * Which states the backend will actually let a devotee cancel from - the
 * `cancel_devotee` trigger in the state machine is only declared for these
 * three. The Cancel button used to show for every LIVE state, including
 * `in_progress`: a devotee could click it while the purohit was mid-ritual at
 * their home, and the request would 422 with INVALID_TRANSITION - a dead
 * button dressed as a working one, on the single worst moment to discover
 * that ("cancel" while someone is performing a puja in your living room makes
 * no sense to offer in the first place).
 */
const CANCELLABLE = new Set(['draft', 'pending_accept', 'confirmed']);

const TONE: Record<string, string> = {
  confirmed: 'ok', in_progress: 'ok', completed: 'done', reviewed: 'done',
  pending_accept: 'wait', draft: 'wait',
  cancelled_devotee: 'off', cancelled_pandit: 'off', expired: 'off',
};

/**
 * Double-blind (see ADR on reviews.service.ts): neither side sees the other's
 * rating until both have submitted, or 72 hours pass. This form only ever
 * writes the devotee's own submission - it never reads or shows the purohit's.
 * The endpoint already existed with nothing anywhere calling it.
 */
function ReviewForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [panditStars, setPanditStars] = useState(0);
  const [punctualityStars, setPunctualityStars] = useState(0);
  const [samagriStars, setSamagriStars] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stars = (value: number, onChange: (n: number) => void, label: string) => (
    <div className="stars-row">
      <span className="muted" style={{ fontSize: '.85rem' }}>{label}</span>
      <div className="stars" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n}
                  aria-label={`${n} star${n === 1 ? '' : 's'}`}
                  className={`star${n <= value ? ' on' : ''}`}
                  onClick={() => onChange(n)}>
            ★
          </button>
        ))}
      </div>
    </div>
  );

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/v1/bookings/${bookingId}/review`, {
        method: 'POST',
        body: JSON.stringify({
          ...(panditStars ? { panditStars } : {}),
          ...(punctualityStars ? { punctualityStars } : {}),
          ...(samagriStars ? { samagriStars } : {}),
          ...(text.trim() ? { text: text.trim() } : {}),
        }),
      });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card quiet" style={{ marginTop: 8 }}>
      <h4 style={{ marginTop: 0 }}>How was it?</h4>
      {stars(panditStars, setPanditStars, 'The purohit')}
      {stars(punctualityStars, setPunctualityStars, 'Punctuality')}
      {stars(samagriStars, setSamagriStars, 'Pooja materials')}
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
                placeholder="Anything you'd like to share (optional)"
                style={{ width: '100%', marginTop: 10, minHeight: 70 }} />
      {err && <div className="notice err" style={{ marginTop: 8 }}>{err}</div>}
      <button className="btn" style={{ marginTop: 10 }} disabled={busy || panditStars === 0}
              onClick={() => void submit()}>
        {busy ? 'Sending…' : 'Submit feedback'}
      </button>
      {panditStars === 0 && (
        <p className="muted" style={{ fontSize: '.8rem', marginTop: 6 }}>
          Rate the purohit to submit.
        </p>
      )}
    </div>
  );
}

function AccountInner() {
  const router = useRouter();
  const params = useSearchParams();
  const {
    money, date: fmtDate, slotLabel, timeRange, region,
    // Date rendering that honours the city's zone rather than the browser's —
    // see `whenLabel`/`monthLabel`/the timeline, all of which hand-rolled it.
    dateTime, month: monthLabel, relativeDay,
  } = useRegion();

  const [tab, setTab] = useState<TabId>(
    (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'bookings') as TabId,
  );
  const [me, setMe] = useState<Me | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addingAddress, setAddingAddress] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A booking was a row you could look at but never open. Name, price total and a
  // status word is not enough to answer "who is coming," "what exactly am I
  // paying for," or "did my review go through" - all of which only ever existed
  // by calling the API directly.
  /*
   * Opened from `?booking=`, so the view survives a refresh.
   *
   * `?tab=` was already READ here — the header's account menu links to
   * `/account?tab=profile` — and never written back, so the address bar and the
   * screen disagreed the moment anyone touched a tab: refreshing threw you back to
   * Bookings, and the link you copied to send someone went to the wrong section.
   * The detail view was worse, being the thing most worth linking to: it had no URL
   * at all, so a refresh — or following the WhatsApp support link and coming back —
   * closed the booking you were reading.
   */
  const [selectedId, setSelectedId] = useState<string | null>(
    params.get('booking'),
  );
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [otps, setOtps] = useState<{ startOtp?: string; completeOtp?: string } | null>(null);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  // Reschedule: the membership plan has advertised "free rescheduling up to 24
  // hours before" since the catalogue was seeded, with nothing behind it - the
  // only way to change a date was to cancel (forfeiting up to the full amount
  // inside 48 hours) and rebook at whatever price and purohit were free next.
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedDays, setReschedDays] = useState<DaySlots[] | null>(null);
  const [reschedErr, setReschedErr] = useState<string | null>(null);
  const [reschedDate, setReschedDate] = useState<string | null>(null);
  const [reschedSlotIdx, setReschedSlotIdx] = useState<number | null>(null);
  const [reschedBusy, setReschedBusy] = useState(false);
  const [reschedDone, setReschedDone] = useState(false);

  /**
   * Mirror the screen into the address bar.
   *
   * `replace`, not `push`. A dashboard with four tabs and a modal would otherwise
   * build a history entry per tap, and the back button — the one a phone user
   * presses to LEAVE — would instead walk them backwards through their own
   * browsing of this page, four or five presses deep. Replace keeps the URL
   * shareable and refresh-safe, which is the whole point, without turning Back
   * into a tab-undo stack.
   *
   * `scroll: false` because this is the same page; letting Next jump to the top on
   * every tab change loses the reader's place in a long booking history.
   */
  const syncUrl = (next: { tab?: TabId; booking?: string | null }) => {
    const q = new URLSearchParams(params.toString());
    const nextTab = next.tab ?? tab;
    // 'bookings' is the default, so it stays out of the URL rather than making
    // every shared link carry a parameter that changes nothing.
    if (nextTab === 'bookings') q.delete('tab'); else q.set('tab', nextTab);
    const nextBooking = next.booking === undefined ? selectedId : next.booking;
    if (nextBooking) q.set('booking', nextBooking); else q.delete('booking');
    const qs = q.toString();
    router.replace(qs ? `/account?${qs}` : '/account', { scroll: false });
  };

  const selectTab = (next: TabId) => { setTab(next); syncUrl({ tab: next }); };
  const openBooking = (id: string | null) => {
    setSelectedId(id);
    syncUrl({ booking: id });
  };

  useEffect(() => {
    setPayErr(null); setOtps(null); setReviewSubmitted(false);
    setReschedOpen(false); setReschedDays(null); setReschedErr(null);
    setReschedDate(null); setReschedSlotIdx(null); setReschedDone(false);
    if (!selectedId) { setDetail(null); setDetailErr(null); return; }
    let cancelled = false;
    setDetail(null); setDetailErr(null);
    api<BookingDetail>(`/v1/bookings/${selectedId}?locale=en`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setDetailErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const refreshDetail = async (id: string) => {
    const [d] = await Promise.all([
      api<BookingDetail>(`/v1/bookings/${id}?locale=en`),
      api<Booking[]>('/v1/bookings?locale=en').then(setBookings),
    ]);
    setDetail(d);
  };

  /**
   * The SAME purohit's own calendar, not the general search — a reschedule
   * never changes who is coming, only when. `/v1/availability` already existed
   * for exactly this (nothing on the devotee side ever called it); it returns
   * every slot's real status, so only what is genuinely 'open' is offered.
   */
  const openReschedule = async () => {
    if (!detail) return;
    setReschedOpen(true); setReschedErr(null); setReschedDate(null); setReschedSlotIdx(null);
    if (reschedDays) return;
    try {
      const from = todayIso();
      const to = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
      const days = await api<DaySlots[]>(
        `/v1/availability?panditId=${detail.panditId}&from=${from}&to=${to}`,
      );
      setReschedDays(days);
    } catch (e) { setReschedErr((e as Error).message); }
  };

  const confirmReschedule = async () => {
    if (!detail || !reschedDate || reschedSlotIdx === null) return;
    setReschedBusy(true); setReschedErr(null);
    try {
      await api(`/v1/bookings/${detail.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({
          date: reschedDate, slotIdx: reschedSlotIdx, idempotencyKey: idemKey(),
        }),
      });
      setReschedDone(true);
      setReschedOpen(false);
      await refreshDetail(detail.id);
    } catch (e) { setReschedErr((e as Error).message); } finally { setReschedBusy(false); }
  };

  /**
   * Resuming a payment that was abandoned.
   *
   * This claimed to mirror `/book`'s `pay()` and did not: it called the dev-only
   * `simulate-token-capture` unconditionally, with no `keyId` branch. That endpoint
   * refuses to run when `NODE_ENV=production`, so the one path back to payment for a
   * devotee who left checkout and returned answered 403 in production — to exactly
   * the customers most worth recovering.
   *
   * Both screens now go through `payForBooking`, so the branch cannot drift apart
   * again. `state` is passed because a booking can still be sitting in `draft`:
   * `/book` issues create and submit as two requests and the second can be lost to a
   * closed tab, and `payment-intent` rejects a draft outright.
   */
  const payNow = async () => {
    if (!detail) return;
    setPaying(true); setPayErr(null);
    try {
      const outcome = await payForBooking({
        bookingId: detail.id,
        description: detail.ritualName ?? detail.ritualSlug,
        state: detail.state,
        prefillName: me?.name,
      }, api);

      // Closing the sheet leaves the booking exactly as it was, and the button
      // still says pay — there is nothing to report and nothing to fix.
      if (outcome.status === 'dismissed') return;
      if (outcome.status === 'failed') { setPayErr(outcome.reason); return; }
      if (outcome.status === 'pending') {
        setPayErr('Your payment went through and we are still confirming it. '
                + 'Check back in a moment — do not pay again.');
        return;
      }
      setOtps(outcome.codes);
      await refreshDetail(detail.id);
    } catch (e) { setPayErr((e as Error).message); } finally { setPaying(false); }
  };

  /**
   * Mount-only. Depending on `router` looks harmless because Next returns a stable
   * object, but any caller that returns a fresh one turns this into fetch → setState →
   * re-render → fetch, which climbs to an out-of-memory crash rather than failing
   * cleanly. The data here is loaded once per visit; the deps should say so.
   */
  useEffect(() => {
    if (!auth.token) { router.replace('/login?next=/account'); return; }
    // This page is the devotee's. A purohit landing here saw "Book a pooja" and
    // "which panchang does your family follow" — the wrong side of the marketplace.
    if (auth.role === 'pandit') { router.replace('/purohit'); return; }
    api<Me>('/v1/auth/me').then(setMe).catch((e) => setErr((e as Error).message));
    api<Booking[]>('/v1/bookings?locale=en')
      .then(setBookings)
      .catch((e) => { setBookings([]); setErr((e as Error).message); });
    api<Address[]>('/v1/me/addresses').then(setAddresses).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { upcoming, past } = useMemo(() => {
    const all = bookings ?? [];
    return {
      /*
       * Soonest first — what to do next.
       *
       * `GET /v1/bookings` orders by `created_at DESC` (booking-read.controller.ts
       * `mine()`), which is creation order, and nothing re-sorted the live ones. So
       * a Diwali puja booked this morning sat ABOVE tomorrow's griha prabesh booked
       * last week: the top of the devotee's own dashboard was the booking needing
       * attention LAST. The purohit's `me/jobs` endpoint already carries this exact
       * fix in SQL, with the comment explaining why ("active jobs sort soonest-first
       * — what to do next"); the devotee's side never got it.
       *
       * Sorted on `slotStartAt`, the instant the booking was actually made against,
       * rather than `date` — two bookings on one day order by time of day, and
       * `slotIdx` is vestigial (ADR 0013).
       */
      upcoming: all.filter((b) => LIVE.has(b.state))
        .slice().sort((a, b) => a.slotStartAt.localeCompare(b.slotStartAt)),
      // By ceremony date, not creation order - a ledger reads back through time
      // by when things happened, not by when the row was written.
      past: all.filter((b) => !LIVE.has(b.state))
        .slice().sort((a, b) => b.date.localeCompare(a.date)),
    };
  }, [bookings]);

  /*
   * Past, grouped the way a passbook reads: one page per month, most recent
   * first, with a running "what this actually cost" total. Ten bookings in one
   * flat list answered "what happened" but never "how much have I spent" -
   * the number every family asking to see their bookings actually wants.
   * Refunded/cancelled bookings did not cost anything, so they are shown
   * (nothing here is hidden) but not counted in the total.
   */
  const { pastByMonth, lifetimeSpentPaise, completedCount } = useMemo(() => {
    const groups = new Map<string, Booking[]>();
    for (const b of past) {
      const key = b.date.slice(0, 7);
      const list = groups.get(key);
      if (list) list.push(b); else groups.set(key, [b]);
    }
    const spent = past.filter((b) => b.state === 'completed' || b.state === 'reviewed');
    return {
      pastByMonth: [...groups.entries()],
      lifetimeSpentPaise: spent.reduce((sum, b) => sum + b.price.totalPaise, 0),
      completedCount: spent.length,
    };
  }, [past]);

  const setPanjika = async (school: string) => {
    setSaving(true);
    try {
      await api('/v1/me/panjika', { method: 'PATCH', body: JSON.stringify({ school }) });
      setMe((m) => (m ? { ...m, panjikaSchool: school } : m));
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  const signOut = () => { auth.clear(); router.push('/'); };

  /**
   * The devotee had no way to cancel anywhere in the product — only the API knew
   * how. The refund rules are stated before they commit, not after.
   */
  const cancelBooking = async (b: Booking) => {
    // The refund rule is on screen above this button now, so the dialog no
    // longer has to be the first place it is stated - it only has to make the
    // action deliberate, and name what is being cancelled.
    const ok = window.confirm(
      `Cancel ${b.ritualName ?? b.ritualSlug} on ${fmtDate(b.date)}?\n\n`
      + 'This cannot be undone.',
    );
    if (!ok) return;
    setSaving(true);
    try {
      /*
       * `CancelBookingBody` requires `idempotencyKey` — /cancel is idempotent by
       * contract (see common/idempotency.ts), same as /complete. That field was
       * never sent from here, so `CancelBookingBody.parse` rejected every request
       * with a 422 before it ever reached the booking service: the Cancel button
       * has done nothing but show an error since idempotency was added to this
       * endpoint.
       */
      await api(`/v1/bookings/${b.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'devotee cancelled', idempotencyKey: idemKey() }),
      });
      setBookings(await api<Booking[]>('/v1/bookings?locale=en'));
      // The confirm dialog already asked; returning to the list is the natural
      // next step rather than leaving the modal open on a now-stale state.
      if (selectedId === b.id) openBooking(null);
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  const card = (b: Booking) => (
    /* Cancelled and expired bookings are history, not results. They outnumber
       everything else in a long list and carried identical visual weight, so a
       completed puja sat in a wall of grey tags looking the same as six things
       that never happened. */
    <div className={`bk bk-clickable${TONE[b.state] === 'off' ? ' bk-off' : ''}`}
         key={b.id} role="button" tabIndex={0} data-tone={TONE[b.state] ?? ''}
         onClick={() => openBooking(b.id)}
         onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBooking(b.id); } }}>
      {/*
        The whole date, not just the weekday. This was `fmtDate(...).split(',')[0]`
        — "Sat" — so a list with two Saturday bookings gave no way to tell which
        was which without opening both.
      */}
      <div className="bk-when">
        <span className="d">{fmtDate(b.date)}</span>
        {/*
          The time actually booked, not the slot it was filed under. Kolkata's slots
          leave gaps, so a 12:30 pm booking lands in one and its `slotIdx` falls back
          to 0 — which rendered a 45-minute online aarti as "6am–9am".
        */}
        <span className="t">{timeRange(b.slotStartAt, b.slotEndAt)}</span>
      </div>
      <div className="bk-main">
        <div className="bk-title">{b.ritualName ?? b.ritualSlug}</div>
        <div className="bk-meta">
          {region.name.en} · {b.paymentMode === 'cash' ? 'Cash to pandit' : 'Paid online'}
        </div>
        {/*
          Assigned at draft creation (ADR 0012) and shown on the booking
          confirmation screen - but that screen is seen once, and this list is
          revisited. A devotee coming back here to check on a live booking had
          no way to see who was actually coming.

          The phone number came off this row. It is four lines of digits down a
          list of ten bookings, unreadable at a glance and not tappable anyway;
          it now sits in the detail view behind a Call button.
        */}
        {LIVE.has(b.state) && (
          <div className="bk-who">Purohit: {b.panditName ?? 'Assigned'}</div>
        )}
      </div>
      <div className="bk-end">
        <span className={`tag ${TONE[b.state] ?? ''}`}>{STATE_LABEL[b.state] ?? b.state}</span>
        {/* Tabular numerals - a passbook column of amounts that don't line up
            reads as careless about the one thing a ledger exists to get right. */}
        <span className="bk-amt mono">{money(b.price.totalPaise)}</span>
        {/*
          Cancel used to live here: a destructive action sitting inside a card
          whose whole surface is a button, directly under the price, on a phone.
          It has moved into the detail view, where there is room to state the
          refund rule BEFORE the decision instead of in a confirm() after it.
        */}
        {CANCELLABLE.has(b.state) && <span className="bk-go" aria-hidden="true">›</span>}
      </div>
    </div>
  );

  return (
    <div className="wrap account">
      <header className="acct-head">
        <div className="avatar" aria-hidden="true">
          {(me?.name ?? '·').trim().charAt(0).toUpperCase()}
        </div>
        <div>
          <h1>{me?.name ?? 'Your account'}</h1>
          <p className="sub">{me?.phone ?? ' '}</p>
        </div>
        <button className="btn outline sm" onClick={signOut}>Sign out</button>
      </header>

      {err && <div className="notice err">{err}</div>}

      <div className="tabs" role="tablist" aria-label="Account sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
                  className={`tab${tab === t.id ? ' on' : ''}`}
                  onClick={() => selectTab(t.id)}>
            {t.label}
            {t.id === 'bookings' && upcoming.length > 0 && (
              <span className="n">{upcoming.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'bookings' && (
        <section>
          {bookings === null && (
            <div className="bk-list">
              {[0, 1].map((i) => (
                <div className="bk skeleton-card" key={i}>
                  <div className="sk sk-line" style={{ width: '100%' }} />
                </div>
              ))}
            </div>
          )}

          {bookings !== null && bookings.length === 0 && (
            <div className="card empty-state">
              <div className="ico" aria-hidden="true">🪔</div>
              <h3>No bookings yet</h3>
              {/*
                This promised "your start and completion codes" appear here. They
                cannot: `bookings` stores `start_otp_hash` and `complete_otp_hash`
                (db/schema/booking.ts) and the codes themselves are generated, sent
                over WhatsApp and discarded — there is nothing to render, by design,
                and the detail view shows them once at the moment of payment only.
                A devotee who read this and came back looking for their code found
                no codes anywhere and no explanation.
              */}
              <p className="muted">
                When you book a purohit it appears here — the date, who is coming,
                what it cost, and a way to reach them. Your start and completion
                codes are sent to you on WhatsApp.
              </p>
              <Link href="/book" className="btn">Book a pooja</Link>
            </div>
          )}

          {upcoming.length > 0 && (
            <>
              <h3 className="sec">Upcoming</h3>
              <div className="bk-list">{upcoming.map(card)}</div>
            </>
          )}
          {/*
            Past, as a passbook: one page per month, most recent first, with the
            running total the whole section exists to answer. A flat list of ten
            rows told you what happened; nothing ever added it up.
          */}
          {past.length > 0 && (
            <div className="ledger">
              <div className="ledger-head">
                <h3 className="sec">Past</h3>
                {completedCount > 0 && (
                  <span className="ledger-total">
                    {completedCount} completed · <strong className="mono">{money(lifetimeSpentPaise)}</strong> total
                  </span>
                )}
              </div>
              {pastByMonth.map(([key, items]) => (
                <div className="ledger-page" key={key}>
                  <div className="ledger-month">{monthLabel(key)}</div>
                  <div className="bk-list">{items.map(card)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'profile' && (
        <section className="card">
          <div className="kv"><span className="k">Name</span><span>{me?.name ?? '—'}</span></div>
          <div className="kv"><span className="k">Phone</span><span>{me?.phone ?? '—'}</span></div>
          <div className="kv"><span className="k">City</span><span>{region.name.en}</span></div>
          <div className="kv"><span className="k">Account type</span>
            <span style={{ textTransform: 'capitalize' }}>{me?.role ?? '—'}</span></div>
          <p className="muted" style={{ margin: '14px 0 0', fontSize: '.87rem' }}>
            To change your name or phone number, contact support — the phone number is
            what secures your bookings.
          </p>
        </section>
      )}

      {/*
        Addresses, as something the devotee can actually MANAGE.

        `POST /v1/me/addresses` has existed since the booking flow needed it — its
        own docstring records that before it, `addresses` held exactly one row, the
        seeded demo devotee's, and "anyone who registered their own account reached
        the end of the booking flow and hit 'no saved address', with no way anywhere
        in the product to add one". The endpoint fixed that for `/book`. This tab
        kept listing rows read-only and telling the reader their address would
        appear here once they booked — so the one screen named "Addresses" was the
        one place you could not add an address, and a family moving house had to
        start a booking they did not want in order to save the new one.
      */}
      {tab === 'addresses' && (
        <section>
          {addresses.length === 0 && !addingAddress ? (
            <div className="card empty-state">
              <div className="ico" aria-hidden="true">📍</div>
              <h3>No saved addresses</h3>
              <p className="muted">
                Save where your pujas happen and it is ready to pick at checkout —
                your purohit&apos;s travel is worked out from it.
              </p>
              <button className="btn" onClick={() => setAddingAddress(true)}>
                Add an address
              </button>
            </div>
          ) : (
            <>
              <div className="addr-list">
                {addresses.map((a) => (
                  /* `.addr-saved`, not `.bk` — see the CSS. A booking row's grid
                     put this text in its 112px date column. */
                  <div className="addr-saved" key={a.id}>
                    <div className="lb">{a.label ?? 'Home'}</div>
                    <div className="ln">
                      {a.line1}{a.line2 ? `, ${a.line2}` : ''} · {a.city} {a.pincode}
                    </div>
                  </div>
                ))}
              </div>
              {addingAddress ? (
                <div style={{ marginTop: 14 }}>
                  <AddressForm
                    idPrefix="acct-addr"
                    onSaved={(saved) => {
                      /*
                        Prepended, matching the API's `created_at DESC` order, so
                        the list stays in the order a refetch would produce rather
                        than reordering itself the next time the page loads.
                        `POST me/addresses` answers in the same shape as the GET,
                        city name included, so this row and a refetched one are
                        identical — no placeholder to be corrected later.
                      */
                      setAddresses((list) => [saved, ...list]);
                      setAddingAddress(false);
                    }}
                    onCancel={addresses.length > 0 ? () => setAddingAddress(false) : undefined}
                  />
                </div>
              ) : (
                <button className="btn outline" style={{ marginTop: 14 }}
                        onClick={() => setAddingAddress(true)}>
                  + Add another address
                </button>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'preferences' && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Which almanac does your family follow?</h3>
          <p className="muted" style={{ fontSize: '.9rem' }}>
            This decides which dates we call auspicious. Where the schools disagree, we
            show you both rather than picking one silently.
          </p>
          <div className="opt-row" style={{ marginTop: 14 }}>
            {region.panjikas.map((p) => (
              <button key={p.id} disabled={saving}
                      className={`opt ${me?.panjikaSchool === p.id ? 'on' : ''}`}
                      onClick={() => void setPanjika(p.id)}>
                {p.english}
                <span className="s">{p.note}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/*
        A booking row showed a name, a date and a total - nothing about who was
        coming beyond a phone number, no itemised price, no way back to an
        unpaid booking, no way to leave feedback, and no help contact scoped to
        THIS booking. Every one of those already existed as an API call with no
        UI anywhere. One view, opened by clicking the row it belongs to.
      */}
      {selectedId && (
        <Modal title={detail?.ritualName ?? detail?.ritualSlug ?? 'Booking'}
               labelledBy="booking-detail-h" onClose={() => openBooking(null)}>
          {detailErr && <div className="notice err">{detailErr}</div>}

          {!detail && !detailErr && (
            <div className="card skeleton-card"><div className="sk sk-line" style={{ width: '100%' }} /></div>
          )}

          {detail && (
            <div className="bk-detail">
              {/*
                When and where, at the top and in words a person uses. The date
                used to sit in grey micro-text beside the status tag; it is the
                thing being looked up most often, so it leads.
              */}
              <div className="bd-when">
                <div className="bd-date">
                  {fmtDate(detail.date)}
                  {relativeDay(detail.date) && (
                    <span className="bd-rel">{relativeDay(detail.date)}</span>
                  )}
                </div>
                <div className="bd-slot">{timeRange(detail.slotStartAt, detail.slotEndAt)}</div>
                <span className={`tag ${TONE[detail.state] ?? ''}`}>
                  {stateLabel(detail.state, 'devotee')}
                </span>
              </div>

              {/* The one sentence saying what this means for the reader. */}
              {(() => {
                const step = nextStep(
                  detail.state, detail.paymentMode, detail.deliveryMode === 'virtual',
                );
                return step ? <p className={`bd-next ${step.tone}`}>{step.text}</p> : null;
              })()}

              {/* Purohit — with a way to actually reach them. The number was
                  plain text, so on the morning of a ceremony the only way to
                  call the person coming to your house was to retype it. */}
              <div className="bd-person">
                <div className="avatar" aria-hidden="true">
                  {(detail.panditName ?? 'P').trim().charAt(0).toUpperCase()}
                </div>
                <div className="bd-person-id">
                  <div className="who">{detail.panditName ?? 'Your purohit'}</div>
                  <div className="why">
                    {[
                      detail.panditProfile?.experienceYears
                        ? `${detail.panditProfile.experienceYears} years`
                        : null,
                      detail.panditProfile?.languages?.length
                        ? detail.panditProfile.languages.join(', ')
                        : null,
                    ].filter(Boolean).join(' · ') || 'Assigned to your booking'}
                  </div>
                </div>
                {detail.panditPhone && LIVE.has(detail.state) && (
                  <a className="btn outline sm bd-call" href={`tel:${detail.panditPhone}`}>
                    Call
                  </a>
                )}
              </div>

              {/*
                Where. Carried on the booking since it was drafted and never
                shown anywhere the devotee could look it up again.

                A remote service still carries whichever address the devotee had
                saved — nothing clears it, because nobody is travelling to it —
                so these two must be exclusive. Rendering both put "Where: 12
                Hindusthan Park" directly above "Where: Online" on the same
                booking.
              */}
              {detail.deliveryMode === 'virtual' ? (
                <div className="bd-row">
                  <span className="bd-row-k">Where</span>
                  <span className="bd-row-v">
                    {/*
                      This line used to promise that "joining details are sent on
                      WhatsApp before the ceremony" — for a ₹499 product with no
                      video anywhere in the system. The link is real now, so the
                      screen shows it rather than describing a message.
                    */}
                    {detail.joinUrl ? (
                      <a href={detail.joinUrl} target="_blank" rel="noopener noreferrer">
                        Join the ceremony
                      </a>
                    ) : (
                      'Online — your purohit sends the video link before the ceremony, '
                      + 'here and on WhatsApp.'
                    )}
                  </span>
                </div>
              ) : detail.venue ? (
                <div className="bd-row">
                  <span className="bd-row-k">Where</span>
                  <span className="bd-row-v">
                    {detail.venue.label ? <strong>{detail.venue.label}</strong> : null}
                    {detail.venue.label ? ' · ' : ''}
                    {detail.venue.line1}
                    {detail.venue.line2 ? `, ${detail.venue.line2}` : ''}
                    {` — ${detail.venue.pincode}`}
                  </span>
                </div>
              ) : null}

              {/*
                The recording of a puja nobody was in the room for. It is the thing
                a family who booked from Dubai for their parents in Kolkata actually
                bought, and it had nowhere to live until now.
              */}
              {detail.recordingUrl && (
                <div className="bd-row">
                  <span className="bd-row-k">Recording</span>
                  <span className="bd-row-v">
                    <a href={detail.recordingUrl} target="_blank" rel="noopener noreferrer">
                      Watch your puja
                    </a>
                  </span>
                </div>
              )}

              {/* Full price breakdown - the data always existed on the booking;
                  it was rendered once, on the confirmation screen, and never
                  again anywhere a devotee could revisit. */}
              <h4 style={{ marginBottom: 8, marginTop: 20 }}>Price</h4>
              <div className="bill">
                <div className="line"><span>Dakshina</span><span>{money(detail.price.dakshinaPaise)}</span></div>
                {detail.price.samagriPaise > 0 && (
                  <div className="line"><span>Pooja materials</span><span>{money(detail.price.samagriPaise)}</span></div>
                )}
                {detail.price.travelPaise > 0 && (
                  <div className="line"><span>Travel</span><span>{money(detail.price.travelPaise)}</span></div>
                )}
                <div className="line">
                  <span>Service fee · {detail.price.commissionBps / 100}%</span>
                  <span>{money(detail.price.platformFeePaise)}</span>
                </div>
                {detail.price.discountPaise > 0 && (
                  <div className="line"><span>Discount</span><span>−{money(detail.price.discountPaise)}</span></div>
                )}
                <div className="line total">
                  <span>Total</span>
                  <span className="amt">{money(detail.price.totalPaise)}</span>
                </div>
                <div className="pay-split">
                  {/*
                    Hidden at zero, as on the booking screen. A booking taken on a
                    cash-only deployment has no token, and "Paid online ₹0" against
                    it is a line about a payment that never happened.
                  */}
                  {detail.price.tokenPaise > 0 && (
                    <div className="line now">
                      <span>
                        {detail.state === 'draft' || detail.state === 'pending_accept' ? 'Due now' : 'Paid online'}
                      </span>
                      <span>{money(detail.price.tokenPaise)}</span>
                    </div>
                  )}
                  <div className="line due">
                    <span>{detail.paymentMode === 'cash' ? 'Cash to purohit on the day' : 'Charged on completion'}</span>
                    <span>{money(detail.price.balancePaise)}</span>
                  </div>
                  {detail.cashCollectedPaise !== null && (
                    <div className="line due">
                      <span>Cash collected</span><span>{money(detail.cashCollectedPaise)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Resume payment - the one thing a devotee who left the
                  confirmation screen before paying had no way back to.
                  Includes `draft`: see payNow() for why a booking can be
                  stuck there with nothing else offering a way out. */}
              {(detail.state === 'draft' || detail.state === 'pending_accept') && !otps && (
                <>
                  {payErr && <div className="notice err" style={{ marginTop: 10 }}>{payErr}</div>}
                  <button className="btn-block" style={{ marginTop: 10 }} disabled={paying}
                          onClick={() => void payNow()}>
                    {paying ? 'Working…' : `Pay ${money(detail.price.tokenPaise)} to confirm`}
                  </button>
                </>
              )}
              {otps && (
                <div className="notice ok" style={{ marginTop: 10 }}>
                  Confirmed. Start code <strong className="mono">{otps.startOtp}</strong> · Completion
                  code <strong className="mono">{otps.completeOtp}</strong>
                  {/*
                    Says where to find them again, because this is the only time
                    they are ever on screen — they are stored hashed and cannot be
                    re-displayed. Closing this view used to lose them silently.
                  */}
                  <div className="muted" style={{ fontSize: '.85rem', marginTop: 6 }}>
                    Also sent to you on WhatsApp — they are not shown here again.
                  </div>
                </div>
              )}

              {/*
                Reschedule. "Free rescheduling up to 24 hours before" has been on
                the membership plan since the catalogue was seeded, with no
                endpoint behind it — cancelling and rebooking from scratch (losing
                up to the full amount inside 24 hours) was the only way to change
                a date. Same purohit, same price; only the calendar moves.
              */}
              {detail.state === 'confirmed' && (() => {
                /*
                 * The 24h cutoff is read fresh from `detail` every render, and
                 * `detail` is refetched right after a successful reschedule - so
                 * a move to a slot that itself now falls inside 24 hours (very
                 * common: "the next open slot" often IS tomorrow morning) used to
                 * fall straight into the "too late" branch, which returned before
                 * ever checking `reschedDone`. The confirmation the devotee had
                 * just earned was silently swallowed by the rule that only
                 * applies to what happens NEXT. It now always renders first.
                 */
                const hoursLeft = (new Date(detail.slotStartAt).getTime() - Date.now()) / 3_600_000;
                const tooLate = hoursLeft < 24;
                return (
                  <div className="bd-resched">
                    {reschedDone && !reschedOpen && (
                      <div className="notice ok" style={{ marginBottom: 10 }}>
                        {/*
                          `slotLabel(slotIdx)` is the bug the booking card above
                          documents fixing: since ADR 0013 a booking is a pair of
                          instants and `slot_idx` is vestigial, so a 12:30 booking
                          falls in one of Kolkata's gaps, its index falls back to 0,
                          and the confirmation reported the move as "6am–9am". The
                          refetched booking carries its real window; use that.
                        */}
                        Rescheduled to {fmtDate(detail.date)} ·{' '}
                        {timeRange(detail.slotStartAt, detail.slotEndAt)}.
                      </div>
                    )}

                    {tooLate ? (
                      <>
                        <strong>Need to reschedule?</strong>
                        <p className="muted">
                          This booking starts in under 24 hours, so it can no longer be
                          moved online — message your purohit directly.
                        </p>
                      </>
                    ) : (
                      <div className="spread">
                        <div>
                          <strong>Need to reschedule?</strong>
                          <p className="muted">
                            Same purohit, same price — pick a different open slot of theirs,
                            any time up to 24 hours before.
                          </p>
                        </div>
                        {!reschedOpen && (
                          <button className="btn outline sm" onClick={() => void openReschedule()}>
                            Change date
                          </button>
                        )}
                      </div>
                    )}

                    {!tooLate && reschedOpen && (
                      <div className="resched-panel">
                        {reschedErr && <div className="notice err">{reschedErr}</div>}
                        {!reschedDays && !reschedErr && (
                          <p className="muted">Checking their calendar…</p>
                        )}
                        {reschedDays && (
                          <>
                            <div className="daystrip" role="group" aria-label="Choose a new date">
                              {reschedDays
                                .filter((d) => d.slots.some((s) => s.status === 'open'))
                                .map((d) => {
                                  /*
                                    `fmtDate` is the region's own formatter and
                                    returns "Wed, 16 Sep" — split rather than
                                    re-derived from a browser-zone `new Date`, which
                                    is what put a different weekday on this chip than
                                    the one the API meant for anyone east of IST.
                                  */
                                  const [dow = '', dayMon = ''] = fmtDate(d.date).split(', ');
                                  const [dayNum = '', mon = ''] = dayMon.split(' ');
                                  return (
                                    <button key={d.date}
                                            className={`daychip ${reschedDate === d.date ? 'on' : ''}`}
                                            aria-pressed={reschedDate === d.date}
                                            onClick={() => { setReschedDate(d.date); setReschedSlotIdx(null); }}>
                                      <div className="dow">{dow}</div>
                                      <div className="d">{dayNum}</div>
                                      <div className="mo">{mon}</div>
                                    </button>
                                  );
                                })}
                            </div>
                            {reschedDays.every((d) => !d.slots.some((s) => s.status === 'open')) && (
                              <p className="muted" style={{ marginTop: 8 }}>
                                Nothing open in the next 20 days. WhatsApp us and we will find a slot.
                              </p>
                            )}
                            {reschedDate && (
                              <div className="slotgrid" style={{ marginTop: 14 }}>
                                {(reschedDays.find((d) => d.date === reschedDate)?.slots ?? [])
                                  .filter((s) => s.status === 'open')
                                  .map((s) => (
                                    <button key={s.slotIdx}
                                            className={`slot ${reschedSlotIdx === s.slotIdx ? 'on' : ''}`}
                                            aria-pressed={reschedSlotIdx === s.slotIdx}
                                            onClick={() => setReschedSlotIdx(s.slotIdx)}>
                                      {slotLabel(s.slotIdx)}
                                    </button>
                                  ))}
                              </div>
                            )}
                            {reschedDate && reschedSlotIdx !== null && (
                              <button className="btn-block" style={{ marginTop: 14 }}
                                      disabled={reschedBusy} onClick={() => void confirmReschedule()}>
                                {reschedBusy
                                  ? 'Working…'
                                  : `Move to ${fmtDate(reschedDate)} · ${slotLabel(reschedSlotIdx)}`}
                              </button>
                            )}
                          </>
                        )}
                        <button className="linkish" style={{ marginTop: 10 }}
                                onClick={() => setReschedOpen(false)}>
                          Never mind
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/*
                Cancelling lived on the list row, one mis-tap away from the card
                you were trying to open, and it never said what it would cost —
                the refund rule only appeared in a browser confirm() AFTER the
                decision was made. Here it sits under the price it refers to,
                states the rule up front, and is styled as the destructive thing
                it is rather than as a link beside the amount.
              */}
              {CANCELLABLE.has(detail.state) && (
                <div className="bd-danger">
                  <div>
                    <strong>Need to cancel?</strong>
                    <p className="muted">
                      More than 48 hours ahead: full refund. Inside 48 hours: half.
                      Inside 24 hours: the booking amount is retained.
                    </p>
                  </div>
                  <button className="btn danger sm" disabled={saving}
                          onClick={() => void cancelBooking(detail)}>
                    Cancel booking
                  </button>
                </div>
              )}

              {/* The chanting sample sits here, below the things a booked
                  devotee actually opens this view for. It belongs to choosing a
                  purohit, which has already happened. */}
              {detail.panditProfile?.chantingSampleUrl && (
                <div className="chant" style={{ marginTop: 16 }}>
                  <div className="chant-head">
                    Hear {(detail.panditName ?? 'them').split(' ')[0]} recite
                    {detail.panditProfile.chantingSampleLabel
                      ? ` — ${detail.panditProfile.chantingSampleLabel}` : ''}
                  </div>
                  <audio controls preload="none" src={detail.panditProfile.chantingSampleUrl}>
                    Your browser cannot play audio.
                  </audio>
                </div>
              )}

              {/* Timeline - written to booking_events inside the same
                  transaction as every state change, and never read by
                  anything until now. */}
              {detail.timeline.length > 0 && (
                <>
                  <h4 style={{ marginBottom: 8, marginTop: 20 }}>Timeline</h4>
                  <ul className="tl">
                    {detail.timeline.map((ev) => (
                      <li key={ev.id} className="tl-row">
                        <span>{stateLabel(ev.toState, 'devotee')}</span>
                        {/*
                          `ev.at` is a UTC instant and this formatted it in the
                          BROWSER's zone, while every other time on the screen came
                          from `timeRange` and was correctly the city's. A family
                          booking from abroad for their parents — the case this
                          product is explicitly built for — read the two side by
                          side and they disagreed by hours.
                        */}
                        <span className="muted">{dateTime(ev.at)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/*
                Feedback - double-blind; this only ever writes the devotee's
                own side. See ReviewForm.

                `state === 'reviewed'` does NOT mean the devotee left a
                review - the 72-hour one-sided publish (reviews.service.ts
                publishExpired) flips a booking to `reviewed` off just the
                purohit's side. The backend already accepts a late devotee
                review against a `reviewed` booking (reviews.service.ts
                submit(), state check), so the form stays offered until
                `myReviewSubmitted` - the devotee's own row - actually exists.
              */}
              {(detail.state === 'completed' || detail.state === 'reviewed')
                && !detail.myReviewSubmitted && !reviewSubmitted && (
                <ReviewForm bookingId={detail.id} onDone={() => {
                  setReviewSubmitted(true);
                  void refreshDetail(detail.id);
                }} />
              )}
              {(reviewSubmitted || detail.myReviewSubmitted) && (
                <div className="notice ok" style={{ marginTop: 14 }}>Thank you for your feedback.</div>
              )}

              {/* Help - the same channel and number used everywhere else on the
                  site, not a new one invented for this screen. */}
              <div className="card quiet" style={{ marginTop: 16 }}>
                <strong>Something wrong with this booking?</strong>
                <p className="muted" style={{ fontSize: '.87rem', margin: '6px 0 10px' }}>
                  Message us and a person replies. Booking date: {fmtDate(detail.date)}.
                </p>
                {/* Two ways to reach a person, both tappable. The number used to
                    be plain text that wrapped mid-digits on a phone — the one
                    device that could have dialled it. */}
                <div className="bd-help">
                  <a className="btn outline"
                     href={whatsappLink(
                       `Hello, I need help with my booking on ${detail.date} `
                       + `(${detail.ritualName ?? detail.ritualSlug}).`,
                     )}>
                    WhatsApp us
                  </a>
                  <a className="bd-help-tel" href={PHONE_HREF}>or call {PHONE_DISPLAY}</a>
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

export default function AccountPage() {
  return <Suspense fallback={null}><AccountInner /></Suspense>;
}
