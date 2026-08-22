'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { api, auth, idemKey } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { STATE_LABEL, stateLabel } from '@/lib/format';
import { Modal } from '@/components/modal';
import { whatsappLink, PHONE_DISPLAY } from '@/lib/contact';

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
  panditName: string | null; panditPhone: string; deliveryMode: string;
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
interface BookingDetail extends Booking {
  price: FullPrice;
  timeline: TimelineEvent[];
  panditProfile: PanditProfile | null;
  cashCollectedPaise: number | null;
  myReviewSubmitted: boolean;
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
  const { money, date: fmtDate, slotLabel, region } = useRegion();

  const [tab, setTab] = useState<TabId>(
    (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'bookings') as TabId,
  );
  const [me, setMe] = useState<Me | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A booking was a row you could look at but never open. Name, price total and a
  // status word is not enough to answer "who is coming," "what exactly am I
  // paying for," or "did my review go through" - all of which only ever existed
  // by calling the API directly.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [otps, setOtps] = useState<{ startOtp?: string; completeOtp?: string } | null>(null);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  useEffect(() => {
    setPayErr(null); setOtps(null); setReviewSubmitted(false);
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
   * Mirrors `/book`'s `pay()` exactly - the dev-only stand-in for the Razorpay
   * webhook (see payments.controller.ts). A booking that was left unpaid had no
   * way back to payment at all once the devotee navigated away from the
   * confirmation screen; this endpoint always existed, nothing after that one
   * screen ever called it again.
   *
   * A booking can also still be sitting in `draft`: `/book`'s `book()` calls
   * create then submit as two separate requests, and if the second one never
   * lands (tab closed, connection dropped between the two awaits) the booking
   * is created but never submitted - `payment-intent` requires `pending_accept`
   * (payments.service.ts) and rejects a draft outright. Submitting it first is
   * what `/book` itself would have done a moment later.
   */
  const payNow = async () => {
    if (!detail) return;
    setPaying(true); setPayErr(null);
    try {
      if (detail.state === 'draft') {
        await api(`/v1/bookings/${detail.id}/submit`, { method: 'POST' });
      }
      await api(`/v1/bookings/${detail.id}/payment-intent`, { method: 'POST' });
      const r = await api<{ startOtp?: string; completeOtp?: string }>(
        `/v1/dev/bookings/${detail.id}/simulate-token-capture`, { method: 'POST' });
      setOtps(r);
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
      upcoming: all.filter((b) => LIVE.has(b.state)),
      past: all.filter((b) => !LIVE.has(b.state)),
    };
  }, [bookings]);

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
    const ok = window.confirm(
      `Cancel ${b.ritualName ?? b.ritualSlug} on ${fmtDate(b.date)}?\n\n`
      + 'More than 48 hours ahead: full refund. Inside 48 hours: half. '
      + 'Inside 24 hours: the booking amount is retained.',
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
      if (selectedId === b.id) setSelectedId(null);
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  const card = (b: Booking) => (
    <div className="bk bk-clickable" key={b.id} role="button" tabIndex={0}
         onClick={() => setSelectedId(b.id)}
         onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(b.id); } }}>
      <div className="bk-when">
        <span className="d">{fmtDate(b.date).split(',')[0]}</span>
        <span className="t">{slotLabel(b.slotIdx)}</span>
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
          no way to see who was actually coming, or how to reach them.
        */}
        {LIVE.has(b.state) && (
          <div className="muted" style={{ fontSize: '.85rem', marginTop: 4 }}>
            Purohit: {b.panditName ?? 'Assigned'}{b.panditPhone ? ` · ${b.panditPhone}` : ''}
          </div>
        )}
      </div>
      <div className="bk-end">
        <span className={`tag ${TONE[b.state] ?? ''}`}>{STATE_LABEL[b.state] ?? b.state}</span>
        <span className="bk-amt">{money(b.price.totalPaise)}</span>
        {CANCELLABLE.has(b.state) && (
          <button className="linkish"
                  onClick={(e) => { e.stopPropagation(); void cancelBooking(b); }}>
            Cancel
          </button>
        )}
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
                  onClick={() => setTab(t.id)}>
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
              <p className="muted">
                When you book a pandit, it appears here with the date, the pandit&apos;s
                name and your start and completion codes.
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
          {past.length > 0 && (
            <>
              <h3 className="sec">Past</h3>
              <div className="bk-list">{past.map(card)}</div>
            </>
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

      {tab === 'addresses' && (
        <section>
          {addresses.length === 0 ? (
            <div className="card empty-state">
              <div className="ico" aria-hidden="true">📍</div>
              <h3>No saved addresses</h3>
              <p className="muted">The address you book to will be saved here.</p>
            </div>
          ) : (
            <div className="bk-list">
              {addresses.map((a) => (
                <div className="bk" key={a.id}>
                  <div className="bk-main">
                    <div className="bk-title">{a.label ?? 'Home'}</div>
                    <div className="bk-meta">
                      {a.line1}{a.line2 ? `, ${a.line2}` : ''} · {a.city} {a.pincode}
                    </div>
                  </div>
                </div>
              ))}
            </div>
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
               labelledBy="booking-detail-h" onClose={() => setSelectedId(null)}>
          {detailErr && <div className="notice err">{detailErr}</div>}

          {!detail && !detailErr && (
            <div className="card skeleton-card"><div className="sk sk-line" style={{ width: '100%' }} /></div>
          )}

          {detail && (
            <div className="bk-detail">
              <div className="spread" style={{ marginBottom: 4 }}>
                <span className={`tag ${TONE[detail.state] ?? ''}`}>
                  {stateLabel(detail.state, 'devotee')}
                </span>
                <span className="muted">{fmtDate(detail.date)} · {slotLabel(detail.slotIdx)}</span>
              </div>

              {/* Purohit — name, contact, and the same trust signals the booking
                  confirmation screen shows once and this page never repeated. */}
              <div className="assigned" style={{ marginTop: 14 }}>
                <div className="avatar" aria-hidden="true">
                  {(detail.panditName ?? 'P').trim().charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="who">{detail.panditName ?? 'Your purohit'}</div>
                  <div className="why">
                    {detail.panditPhone}
                    {detail.panditProfile?.experienceYears
                      ? ` · ${detail.panditProfile.experienceYears} years`
                      : ''}
                    {detail.panditProfile?.languages?.length
                      ? ` · ${detail.panditProfile.languages.join(', ')}`
                      : ''}
                  </div>
                </div>
              </div>
              {detail.panditProfile?.chantingSampleUrl && (
                <div className="chant" style={{ marginTop: 10 }}>
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
                <div className="line total"><span>Total</span><span>{money(detail.price.totalPaise)}</span></div>
                <div className="line now">
                  <span>
                    {detail.state === 'draft' || detail.state === 'pending_accept' ? 'Due now' : 'Paid online'}
                  </span>
                  <span>{money(detail.price.tokenPaise)}</span>
                </div>
                <div className="line">
                  <span>{detail.paymentMode === 'cash' ? 'Cash to purohit on the day' : 'Charged on completion'}</span>
                  <span>{money(detail.price.balancePaise)}</span>
                </div>
                {detail.cashCollectedPaise !== null && (
                  <div className="line"><span>Cash collected</span><span>{money(detail.cashCollectedPaise)}</span></div>
                )}
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
                        <span className="muted">
                          {new Date(ev.at).toLocaleString('en-IN', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
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
                <a className="btn outline"
                   href={whatsappLink(
                     `Hello, I need help with my booking on ${detail.date} `
                     + `(${detail.ritualName ?? detail.ritualSlug}).`,
                   )}>
                  WhatsApp us
                </a>
                <span className="muted" style={{ marginLeft: 10, fontSize: '.87rem' }}>
                  or call {PHONE_DISPLAY}
                </span>
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
