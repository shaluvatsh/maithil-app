'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/modal';
import { KycPanel } from '@/components/purohit/kyc';
import { QuickActions } from '@/components/purohit/quick-actions';
import { PurohitOnboarding } from '@/components/purohit/onboarding';
import { api, auth, idemKey } from '@/lib/api';
import { prettyDate, stateLabel } from '@/lib/format';
import { RowSkeletons } from '@/components/skeletons';
import { useRegion } from '@/lib/region-context';

interface Price {
  dakshinaPaise: number; samagriPaise: number; travelPaise: number;
  platformFeePaise: number; totalPaise: number; tokenPaise: number; balancePaise: number;
}
interface Job {
  id: string; state: string; date: string; slotIdx: number; slotSpan: number;
  /** What the purohit is actually committed to; `slotIdx` no longer says. */
  slotStartAt: string; slotEndAt: string;
  ritualName: string | null; ritualSlug: string; price: Price;
  paymentMode: string; acceptDeadlineAt: string | null;
  /** 'virtual' for the two remote rituals; 'at_home' for everything else. */
  deliveryMode: string;
  joinUrl: string | null;
  recordingUrl: string | null;
}

export default function PurohitPage() {
  const router = useRouter();
  // Money and slot windows are per-city data, not constants: the southern cities run
  // five slots on different boundaries, so a hardcoded label array shows a purohit in
  // Bengaluru the times of a job in Kolkata.
  const { money, timeRange } = useRegion();
  const [ready, setReady] = useState(false);
  /**
   * Approval state, and whether the profile is filled in.
   *
   * Fetched here rather than left to `KycPanel`, because it decides which SCREEN
   * this is — the dashboard, or the onboarding checklist that replaces it — and that
   * cannot be settled inside a panel the dashboard renders.
   */
  const [gate, setGate] = useState<{ kycStatus: string; profileComplete: boolean } | null>(null);
  const [ok, setOk] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  /** Distinct from `ready`, which is the auth check — this is the job fetch. */
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [otp, setOtp] = useState<Record<string, string>>({});
  const [cash, setCash] = useState<Record<string, string>>({});
  /** The purohit's own meeting room, for the two rituals sold as remote. */
  const [joinUrl, setJoinUrl] = useState<Record<string, string>>({});
  /** Proof of performance for a puja nobody was in the room for. */
  const [recording, setRecording] = useState<Record<string, string>>({});
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

  /**
   * What the purohit typed, in paise — or the expected balance when the box is
   * empty or unparseable. Never 0 by accident: only an explicit "0" reads as zero.
   */
  const cashPaiseFor = (j: Job): number => {
    const typed = (cash[j.id] ?? '').trim();
    if (typed === '') return j.price.balancePaise;
    const rupees = Number(typed);
    if (!Number.isFinite(rupees) || rupees < 0) return j.price.balancePaise;
    return Math.round(rupees * 100);
  };

  /** Whether they have said what they perform and what they charge. */
  const loadGate = async () => {
    try {
      const p = await api<{
        profile: { kycStatus: string } | null;
        services?: Array<{ ritualId: string }>;
      }>('/v1/me/purohit/profile');
      setGate({
        kycStatus: p.profile?.kycStatus ?? 'pending',
        profileComplete: (p.services?.length ?? 0) > 0,
      });
    } catch { setGate({ kycStatus: 'pending', profileComplete: false }); }
  };

  const load = async () => {
    try {
      const fetched = await api<Job[]>('/v1/me/jobs');
      setJobs(fetched);

      /*
       * `GET /v1/auth/me` used to be fetched here and assigned to a variable nothing
       * read — the fortnight grid it fed moved to the panchang calendar and the call
       * stayed. Every page load and every accept, release or completion paid for a
       * round trip whose result was discarded.
       */
    } catch (e) { setErr((e as Error).message); }
    finally { setLoadingJobs(false); }
  };

  useEffect(() => { setOk(Boolean(auth.token) && isPurohit()); setReady(true); }, []);
  useEffect(() => { if (ok) { void load(); void loadGate(); } }, [ok]);
  /*
   * The redirect belongs in an effect, not in render.
   *
   * `router.replace` was called straight from the render body, which updates the
   * Router while this component is rendering — React logs "Cannot update a component
   * while rendering a different component" on every signed-out visit to the one URL
   * a purohit is sent to by the footer link. It navigated anyway, so it read as
   * noise; it is the kind of noise that hides the next real error in the console.
   */
  useEffect(() => {
    if (ready && !ok) router.replace('/login?next=/purohit');
  }, [ready, ok, router]);

  const act = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); setMsg(note); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!ready) {
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <div className="sk sk-line" style={{ width: 220, height: 26, marginBottom: 18 }} />
        <div className="sk sk-line" style={{ width: 360 }} />
      </div>
    );
  }
  if (!ok) {
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <p className="muted">Taking you to sign in…</p>
      </div>
    );
  }

  // Approval state decides which screen this is, so wait for it rather than
  // flashing the dashboard at someone who is not entitled to it yet.
  if (!gate) {
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <div className="sk sk-line" style={{ width: 220, height: 26, marginBottom: 18 }} />
        <div className="sk sk-line" style={{ width: 360 }} />
      </div>
    );
  }

  /*
   * The dashboard is for purohits who can actually receive work.
   *
   * An unapproved purohit landed on a job inbox that cannot receive a job, ₹0
   * earnings that cannot change, and a calendar nobody can book — devotees only ever
   * match a `verified` purohit. None of those panels said why they were empty.
   */
  if (gate.kycStatus !== 'verified') {
    return (
      <PurohitOnboarding kycStatus={gate.kycStatus} profileComplete={gate.profileComplete} />
    );
  }

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <h1>Your jobs</h1>
      {/*
        * No top-right link here any more. It used to point at `/purohit/setup`
        * under the label "Profile & availability" — a page that, by the time a
        * purohit reaches this screen, no longer covers availability at all (that
        * moved to the action below) and covers only one of four things that link
        * once promised. Your name, top right, is where all of it lives now.
        */}
      <p className="sub">Requests and your calendar.</p>

      {err && <div className="notice err">{err}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {/* Unverified and invisible to devotees is the one thing that must still
          interrupt this page — everything else moved to its own destination under
          the profile menu: the dashboard, payouts, services & rates. */}
      <KycPanel />

      {/* Auto-accept and the calendar action: both govern how a JOB is handled,
          which is what this page is about, so both stay here rather than on a
          settings page about who the purohit is. */}
      <QuickActions />

      {/*
        Jobs first.

        The order used to be stats, then the payout form, then a "Job inbox"
        heading — under which sat the EARNINGS panel, not the jobs. So the one
        thing a purohit opens this page for was below a bank form, two counters
        and a ledger summary, and the heading above it described something else.
        Money is what they came back for on payday; the work is what they came
        back for on every other day, so the work leads and the money follows it
        under its own heading.
      */}
      <h2>Job inbox</h2>

      {loadingJobs && <RowSkeletons count={3} height={96} />}
      {!loadingJobs && jobs.length === 0 && (
        /*
          * The purohit does not make bookings, they receive them.
          *
          * This read "Create a booking on the Book tab" — the devotee's empty state,
          * sending supply to the demand side of the marketplace to fix an empty
          * inbox. What actually fills it is finishing verification and opening a
          * calendar, which is also the honest answer to "why is nothing here".
          */
        <p className="muted">
          Nothing yet. Requests will appear here once you are verified and your
          calendar is open.
        </p>
      )}

      <div className="grid c2">
        {jobs.map((j) => (
          <div className="card" key={j.id}>
            <div className="spread">
              <strong>{j.ritualName ?? j.ritualSlug}</strong>
              <span className="tag">{stateLabel(j.state, 'pandit')}</span>
            </div>
            <div className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
              {/* The real window, not the slot it was filed under — see the
                  devotee list for why those disagree. */}
              {prettyDate(j.date)} · {timeRange(j.slotStartAt, j.slotEndAt)}
              {' · '}{j.paymentMode === 'cash' ? 'Cash' : 'Online'}
            </div>

            <div className="bill" style={{ marginBottom: 10 }}>
              <div className="line">
                <span>You receive</span>
                <strong>{money(j.price.dakshinaPaise + j.price.samagriPaise + j.price.travelPaise)}</strong>
              </div>
              {j.paymentMode === 'cash' && (
                <div className="line"><span>Collect in cash</span>
                  <strong>{money(j.price.balancePaise)}</strong></div>
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

            {/*
              A remote puja needs a room, and there was none. `online-aarti` and
              `virtual-consultation` have been on sale since the catalogue was
              seeded with no video anywhere in the product — the devotee paid and
              neither side had a way to reach the other. Your own meeting link,
              because a room you already run beats one we would have to build.
            */}
            {j.deliveryMode === 'virtual'
              && (j.state === 'pending_accept' || j.state === 'confirmed') && (
              <div className={`field ${j.joinUrl ? '' : 'notice warn'}`}
                   style={{ marginBottom: 10, padding: j.joinUrl ? undefined : 12 }}>
                {/*
                  Loud until it is done. This was one more field among several, so a
                  purohit could pay it no attention and the devotee — who has already
                  paid in full for a ceremony delivered entirely over video — would
                  have nothing to join. The link IS the delivery on a remote booking.
                */}
                <label htmlFor={`join-${j.id}`}>
                  {j.joinUrl
                    ? 'Video link (sent to the devotee)'
                    : 'This puja is online — send your video link'}
                </label>
                <div className="row">
                  <input id={`join-${j.id}`} type="url" style={{ flex: 1 }}
                         placeholder="https://meet.google.com/…"
                         value={joinUrl[j.id] ?? j.joinUrl ?? ''}
                         onChange={(e) => setJoinUrl({ ...joinUrl, [j.id]: e.target.value })} />
                  <button className="btn outline"
                          disabled={busy || !(joinUrl[j.id] ?? j.joinUrl ?? '').startsWith('http')}
                          onClick={() => act(() => api(`/v1/bookings/${j.id}/join-link`, {
                            method: 'POST',
                            body: JSON.stringify({ joinUrl: joinUrl[j.id] ?? j.joinUrl }),
                          }), 'Link sent to the devotee.')}>
                    {j.joinUrl ? 'Update' : 'Send'}
                  </button>
                </div>
                {!j.joinUrl && (
                  <p style={{ fontSize: 12, marginTop: 6 }}>
                    <strong>The devotee has paid and cannot join until you send this.</strong>{' '}
                    WhatsApp video or Meet — whatever you already use.
                  </p>
                )}
              </div>
            )}

            {j.state === 'confirmed' && (
              <div>
                {/*
                  No family-name/gotra fields here any more. That used to be asked
                  of the purohit at this exact point — it was already moved off the
                  payment screen for being too personal there — but it is personal
                  information about the family either way, and the app has no need
                  to hold it. The purohit still asks on arrival; it is just never
                  typed into this screen or shown back to them.
                */}
                <div className="row">
                  <input placeholder="start code" maxLength={6} className="mono"
                         style={{ width: 120 }}
                         value={otp[j.id] ?? ''}
                         onChange={(e) => setOtp({ ...otp, [j.id]: e.target.value })} />
                  <button className="btn" disabled={busy || (otp[j.id]?.length ?? 0) !== 6}
                          onClick={() => act(() => api(`/v1/bookings/${j.id}/start`, {
                            method: 'POST',
                            body: JSON.stringify({ otp: otp[j.id] }),
                          }), 'Started.')}>
                    Begin
                  </button>
                </div>
              </div>
            )}

            {j.state === 'in_progress' && (
              <div>
                {/*
                  For a puja nobody attended in person, the recording is what the
                  devotee actually bought — and, per the founding blueprint's own
                  risk table, what prevents a chargeback. Not asked on an at-home
                  puja: that family watched it happen.
                */}
                {j.deliveryMode === 'virtual' && (
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label htmlFor={`rec-${j.id}`}>Link to the recording</label>
                    <input id={`rec-${j.id}`} type="url"
                           placeholder="https://…  (optional, but it is what they keep)"
                           value={recording[j.id] ?? ''}
                           onChange={(e) => setRecording({ ...recording, [j.id]: e.target.value })} />
                  </div>
                )}
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
                            /*
                             * `??` only falls back on null/undefined, and the field
                             * starts pre-filled — so a purohit who cleared it to
                             * retype left `''`, and `Number('')` is 0. That reported
                             * ZERO cash collected on a real cash job, silently, with
                             * the expected amount still on screen a moment earlier.
                             * Anything not a real number falls back to the balance.
                             */
                            ...(j.paymentMode === 'cash'
                              ? { cashCollectedPaise: cashPaiseFor(j) }
                              : {}),
                            ...((recording[j.id] ?? '').startsWith('http')
                              ? { recordingUrl: recording[j.id] }
                              : {}),
                          }),
                        }), 'Completed and settled.')}>
                  Complete
                </button>
                {j.paymentMode === 'cash' && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    The amount must match {money(j.price.balancePaise)} exactly. Anything else
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
            {prettyDate(releasing.date)} · {timeRange(releasing.slotStartAt, releasing.slotEndAt)}
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

      {/* Earnings moved to its own page under the profile menu — Payouts — beside
          the account it is paid to, which answers "what am I owed" and "where does
          it go" in one place instead of two. */}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your working calendar</h2>
        <p className="muted" style={{ fontSize: '.93rem' }}>
          Open and close your time on the panchang, day by day. A booking blocks the
          hours around it by however long the journey to the next address actually
          takes, so nobody can book you somewhere you could not reach in time — the
          farther apart two jobs are, the more room we leave between them.
        </p>
        <Link href="/panchang" className="btn outline">Open my calendar</Link>
      </div>
    </div>
  );
}
