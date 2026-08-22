'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EarningsPanel } from '@/components/purohit/earnings';
import { Modal } from '@/components/modal';
import { PayoutAccountPanel } from '@/components/purohit/payout-account';
import { KycPanel } from '@/components/purohit/kyc';
import { api, auth, idemKey } from '@/lib/api';
import { rs, SLOT_LABELS_EN, prettyDate, stateLabel } from '@/lib/format';

interface Price {
  dakshinaPaise: number; samagriPaise: number; travelPaise: number;
  platformFeePaise: number; totalPaise: number; tokenPaise: number; balancePaise: number;
}
interface Job {
  id: string; state: string; date: string; slotIdx: number; slotSpan: number;
  ritualName: string | null; ritualSlug: string; price: Price;
  paymentMode: string; acceptDeadlineAt: string | null;
}
interface Slot { slotIdx: number; status: string }
interface Day { date: string; slots: Slot[] }

export default function PurohitPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [ok, setOk] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [otp, setOtp] = useState<Record<string, string>>({});
  const [cash, setCash] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Releasing a job used to go through `window.prompt`.
   *
   * It is the most consequential thing on this screen — it cancels a devotee's puja
   * and triggers a re-match — and it was collected in a browser dialog that is
   * unstyled, untranslatable, suppressible by the browser after a previous dismissal,
   * and blocked outright in a cross-origin iframe. A purohit whose browser silently
   * suppresses it clicks the button and nothing happens at all. The project already
   * has a focus-managing dialog; this uses it.
   */
  const [releasing, setReleasing] = useState<Job | null>(null);
  const [reason, setReason] = useState('');

  const isPurohit = () => auth.role === 'pandit';

  const load = async () => {
    try {
      setJobs(await api<Job[]>('/v1/me/jobs'));
      /*
       * `GET /v1/auth/me` used to be fetched here and assigned to a variable nothing
       * read — the fortnight grid it fed moved to the panchang calendar and the call
       * stayed. Every page load and every accept, release or completion paid for a
       * round trip whose result was discarded.
       */
    } catch (e) { setErr((e as Error).message); }
  };

  useEffect(() => { setOk(Boolean(auth.token) && isPurohit()); setReady(true); }, []);
  useEffect(() => { if (ok) void load(); }, [ok]);

  const act = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); setMsg(note); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const completed = jobs.filter((j) => j.state === 'completed').length;

  if (!ready) {
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <div className="sk sk-line" style={{ width: 220, height: 26, marginBottom: 18 }} />
        <div className="sk sk-line" style={{ width: 360 }} />
      </div>
    );
  }
  if (!ok) {
    router.replace('/login?next=/purohit');
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <p className="muted">Taking you to sign in…</p>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <div className="spread">
        <h1>Your jobs</h1>
        {/* A newly registered purohit lands here with nothing and no idea why.
            This is the only route to the screen that makes them bookable. */}
        <Link href="/purohit/setup" className="btn outline sm">Profile &amp; availability</Link>
      </div>
      <p className="sub">Requests, calendar and earnings.</p>

      {err && <div className="notice err">{err}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {/*
        There were two money figures on this screen and they did not agree.

        This card summed `dakshina + samagri + travel` across whatever jobs happened
        to be in the list, and `EarningsPanel` below it reported the ledger. The card
        knew nothing about the commission on cash jobs, TDS carried under 194-O, or
        what had already been paid out — so it was reliably the larger number, and it
        was the first one a purohit saw. Two numbers for "what I have earned", the
        bigger one wrong, is how a payout becomes a support call.

        The ledger is the only thing that can answer this, so the ledger answers it.
        What is left here is a count, which the job list genuinely does know.
      */}
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="card" style={{ minWidth: 180 }}>
          <div className="muted" style={{ fontSize: 12 }}>Completed pujas</div>
          <div className="stat">{completed}</div>
          <div className="muted" style={{ fontSize: 12 }}>paid out weekly</div>
        </div>
        <div className="card" style={{ minWidth: 180 }}>
          <div className="muted" style={{ fontSize: 12 }}>Awaiting the devotee</div>
          <div className="stat">
            {jobs.filter((j) => j.state === 'pending_accept').length}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>token not yet paid</div>
        </div>
      </div>

      {/* The two things that can leave a purohit stuck without telling them:
          unverified, so invisible to devotees, and unpayable. Both render nothing
          once resolved. */}
      <KycPanel />
      <PayoutAccountPanel />

      <h2>Job inbox</h2>
      {/* What they are owed, above what they have to do. `GET /v1/me/earnings`
          has existed since the payout job was built and nothing rendered it. */}
      <EarningsPanel />

      {jobs.length === 0 && <p className="muted">Nothing yet. Create a booking on the Book tab.</p>}

      <div className="grid c2">
        {jobs.map((j) => (
          <div className="card" key={j.id}>
            <div className="spread">
              <strong>{j.ritualName ?? j.ritualSlug}</strong>
              <span className="tag">{stateLabel(j.state, 'pandit')}</span>
            </div>
            <div className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
              {prettyDate(j.date)} · {SLOT_LABELS_EN[j.slotIdx]}
              {j.slotSpan > 1 && ` (+${j.slotSpan - 1})`}
              {' · '}{j.paymentMode === 'cash' ? 'Cash' : 'Online'}
            </div>

            <div className="bill" style={{ marginBottom: 10 }}>
              <div className="line">
                <span>You receive</span>
                <strong>{rs(j.price.dakshinaPaise + j.price.samagriPaise + j.price.travelPaise)}</strong>
              </div>
              {j.paymentMode === 'cash' && (
                <div className="line"><span>Collect in cash</span>
                  <strong>{rs(j.price.balancePaise)}</strong></div>
              )}
            </div>

            {/* No Accept button: an open slot IS the acceptance under ADR 0011.
                What a purohit needs instead is a way OUT, which did not exist —
                so the re-match path could not be triggered from anywhere. */}
            {/*
              `pending_accept` is waiting on the DEVOTEE'S payment, not on you.
              You accepted this the moment you published the slot — ADR 0011 — and
              the label used to read "Awaiting purohit", so a purohit looked for an
              accept button that was deliberately removed and concluded the app was
              broken. Saying which way the waiting runs is the whole fix.
            */}
            {j.state === 'pending_accept' && (
              <p className="job-wait muted">
                This job is yours. We are waiting for the devotee to pay the token —
                nothing for you to do until then, and you will be told when it clears.
              </p>
            )}

            {(j.state === 'pending_accept' || j.state === 'confirmed') && (
              <button className="btn outline" disabled={busy}
                      onClick={() => { setReleasing(j); setReason(''); }}>
                I cannot take this
              </button>
            )}

            {j.state === 'confirmed' && (
              <div className="row">
                <input placeholder="start code" maxLength={6} className="mono"
                       style={{ width: 120 }}
                       value={otp[j.id] ?? ''}
                       onChange={(e) => setOtp({ ...otp, [j.id]: e.target.value })} />
                <button className="btn" disabled={busy || (otp[j.id]?.length ?? 0) !== 6}
                        onClick={() => act(() => api(`/v1/bookings/${j.id}/start`, {
                          method: 'POST', body: JSON.stringify({ otp: otp[j.id] }),
                        }), 'Started.')}>
                  Begin
                </button>
              </div>
            )}

            {j.state === 'in_progress' && (
              <div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <input placeholder="completion code" maxLength={6} className="mono"
                         style={{ width: 150 }}
                         value={otp[j.id] ?? ''}
                         onChange={(e) => setOtp({ ...otp, [j.id]: e.target.value })} />
                  {j.paymentMode === 'cash' && (
                    <input placeholder="cash collected ₹" className="mono" style={{ width: 150 }}
                           value={cash[j.id] ?? String(j.price.balancePaise / 100)}
                           onChange={(e) => setCash({ ...cash, [j.id]: e.target.value })} />
                  )}
                </div>
                <button className="btn" disabled={busy || (otp[j.id]?.length ?? 0) !== 6}
                        onClick={() => act(() => api(`/v1/bookings/${j.id}/complete`, {
                          method: 'POST',
                          body: JSON.stringify({
                            otp: otp[j.id],
                            capturedAt: new Date().toISOString(),
                            idempotencyKey: idemKey(),
                            ...(j.paymentMode === 'cash'
                              ? { cashCollectedPaise: Math.round(Number(cash[j.id] ?? j.price.balancePaise / 100) * 100) }
                              : {}),
                          }),
                        }), 'Completed and settled.')}>
                  Complete
                </button>
                {j.paymentMode === 'cash' && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    The amount must match {rs(j.price.balancePaise)} exactly. Anything else
                    raises a dispute rather than settling.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/*
        A read-only 14x4 grid of "booked / buffer / closed" used to live here. It
        showed the same rows the panchang calendar now shows — except the calendar
        also lets a purohit change them, and puts them beside the tithi they are
        actually planning around. Two calendars meant holding both in your head and
        editing neither from the one you were looking at.
      */}
      {releasing && (
        <Modal title="Release this job?" onClose={() => setReleasing(null)}>
          <p className="muted">
            {releasing.ritualName ?? releasing.ritualSlug} ·{' '}
            {prettyDate(releasing.date)} · {SLOT_LABELS_EN[releasing.slotIdx]}
          </p>
          <p>
            The devotee is told straight away and we start looking for another
            pandit. Tell them why — it is the difference between a family being
            let down and a family being looked after.
          </p>
          <div className="field">
            <label htmlFor="release-reason">Your reason</label>
            <input id="release-reason" value={reason} maxLength={200}
                   placeholder="A funeral came up in the family"
                   onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn outline" onClick={() => setReleasing(null)}>
              Keep the job
            </button>
            <button className="btn" disabled={busy || reason.trim().length < 3}
                    onClick={() => {
                      const job = releasing;
                      setReleasing(null);
                      /*
                       * Same bug as the devotee's account page had: `CancelBookingBody`
                       * requires `idempotencyKey` (see common/idempotency.ts -
                       * /cancel is idempotent by contract), and this call never sent
                       * one - so "Release it," the single most consequential button on
                       * this screen per the comment above, has 422'd on every attempt.
                       */
                      act(() => api(`/v1/bookings/${job.id}/cancel`, {
                        method: 'POST',
                        body: JSON.stringify({ reason: reason.trim(), idempotencyKey: idemKey() }),
                      }), 'Released. We are finding the devotee another pandit.');
                    }}>
              Release it
            </button>
          </div>
        </Modal>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your working calendar</h2>
        <p className="muted" style={{ fontSize: '.93rem' }}>
          Open and close your slots on the panchang, day by day. Booked slots block
          their neighbours when travel across the city will not fit in the
          thirty-minute gap — so a full day is usually two or three jobs, not four.
        </p>
        <Link href="/panchang" className="btn outline">Open my calendar</Link>
      </div>
    </div>
  );
}
