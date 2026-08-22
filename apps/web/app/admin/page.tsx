'use client';
import { languageNames, traditionNames } from '@themaithil/region';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { rs, prettyDate, STATE_LABEL } from '@/lib/format';

interface Row {
  id: string; state: string; date: string; slotStartAt: string;
  price: { totalPaise: number; tokenPaise: number; platformFeePaise: number };
  paymentMode: string; ritualSlug: string;
  devoteeName: string | null; devoteePhone: string;
  panditPhone: string; panditName: string | null;
}
interface Purohit {
  id: string; name: string | null; phone: string; kycStatus: string;
  experienceYears: number; ratingCount: number; cashJobsEnabled: boolean; languages: string[];
}
interface Entry {
  id: string; txnId: string; bookingId: string | null; direction: string;
  amountPaise: number; type: string; at: string;
  ownerType: string; ownerId: string | null;
}

interface QueueRow {
  id: string; name: string | null; phone: string; kycStatus: string;
  experienceYears: number; languages: string[]; traditions: string[]; documents: number;
}

/**
 * Every incident already lives in `booking_events`, written inside the same
 * transaction that made the change, and nothing has ever read it. So a purohit
 * dropping a job and being silently re-matched is a success nobody sees — and a
 * re-match that silently FAILS is a devotee with no purohit and a slot getting
 * closer, with nobody told until they complain. Under ADR 0012 the platform
 * assigns the purohit, so the platform owns the failure.
 */
interface Incident {
  id: string;
  bookingId: string;
  at: string;
  slotStartAt: string;
  devoteeName: string | null;
  reason: string | null;
  kind: 'substituted' | 'pandit_cancelled' | 'devotee_cancelled';
  rescued: boolean;
  needsAttention: boolean;
}

type Tab = 'bookings' | 'incidents' | 'verify' | 'purohits' | 'ledger';

/** One uploaded document, with a short-lived URL minted for this request only. */
interface KycDoc {
  id: string; type: string; status: string;
  last4: string | null; notes: string | null;
  /** Null once purged — 30 days after a decision, per ADR 0010. */
  viewUrl: string | null;
}

export default function AdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [ok, setOk] = useState(false);
  const [tab, setTab] = useState<Tab>('bookings');
  const [rows, setRows] = useState<Row[]>([]);
  const [purohits, setPurohits] = useState<Purohit[]>([]);
  const [ledger, setLedger] = useState<{ entries: Entry[]; unbalancedTransactions: number } | null>(null);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = () => auth.role === 'admin' || auth.role === 'ops';

  const load = async () => {
    setErr(null);
    try {
      if (tab === 'bookings') setRows(await api<Row[]>('/v1/admin/bookings'));
      if (tab === 'verify') setQueue(await api<QueueRow[]>('/v1/admin/verification-queue'));
      if (tab === 'purohits') {
        setPurohits(await api<Purohit[]>('/v1/admin/pandits'));
        // So the Approvals count is right even when you never open that tab.
        setQueue(await api<QueueRow[]>('/v1/admin/verification-queue'));
      }
      if (tab === 'ledger') setLedger(await api('/v1/admin/ledger'));
      if (tab === 'incidents') setIncidents(await api<Incident[]>('/v1/admin/incidents'));
    } catch (e) { setErr((e as Error).message); }
  };

  useEffect(() => { setOk(Boolean(auth.token) && isAdmin()); setReady(true); }, []);
  useEffect(() => { if (ok) void load(); }, [ok, tab]);

  /**
   * Errors go NEXT TO THE BUTTON, not in a banner at the top of the page.
   * A failure rendered above a long table is invisible to someone scrolled into
   * it, and the click simply looks dead.
   */
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  /*
   * Documents are fetched per purohit, on demand, and never cached.
   *
   * Each carries a five-minute signed URL. Loading every queue member's documents up
   * front would mint dozens of live links to identity scans and leave them sitting in
   * a browser tab — the exact thing the short expiry exists to prevent.
   */
  const [docs, setDocs] = useState<Record<string, KycDoc[]>>({});

  const openDocuments = async (panditId: string) => {
    setRowErr((e) => ({ ...e, [panditId]: '' }));
    try {
      const list = await api<KycDoc[]>(`/v1/admin/pandits/${panditId}/kyc`);
      setDocs((d) => ({ ...d, [panditId]: list }));
    } catch (e) {
      setRowErr((r) => ({ ...r, [panditId]: (e as Error).message }));
    }
  };

  const decide = async (panditId: string, decision: 'verified' | 'rejected') => {
    setBusy(panditId); setErr(null);
    setRowErr((e) => { const { [panditId]: _drop, ...rest } = e; return rest; });
    try {
      await api(`/v1/admin/pandits/${panditId}/verification`, {
        method: 'POST', body: JSON.stringify({ decision }),
      });
      await load();
    } catch (e) {
      const message = (e as Error).message;
      setErr(message);
      setRowErr((prev) => ({ ...prev, [panditId]: message }));
    } finally { setBusy(null); }
  };

  if (!ready) {
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <div className="sk sk-line" style={{ width: 200, height: 26, marginBottom: 18 }} />
        <div className="sk sk-line" style={{ width: 320 }} />
      </div>
    );
  }
  if (!ok) {
    if (!auth.token) { router.replace('/login?next=/admin'); return null; }
    return (
      <div className="wrap" style={{ padding: '40px 20px 80px' }}>
        <div className="notice err">This account does not have admin access.</div>
        <div className="card" style={{ maxWidth: 460 }}>
          <strong>Need an admin account?</strong>
          <p className="muted" style={{ fontSize: '.9rem' }}>
            Sign in once with any number to create the user, then promote it:
          </p>
          <pre className="mono" style={{
            background: 'var(--line-soft)', padding: 12, borderRadius: 8, overflowX: 'auto',
            fontSize: '.82rem',
          }}>{`psql themaithil -c "UPDATE users SET role='admin'
  WHERE phone='+919830012345';"`}</pre>
        </div>
      </div>
    );
  }

  const byState = rows.reduce<Record<string, number>>((a, r) => {
    a[r.state] = (a[r.state] ?? 0) + 1; return a;
  }, {});
  const feeCaptured = rows
    .filter((r) => ['confirmed', 'in_progress', 'completed', 'reviewed'].includes(r.state))
    .reduce((a, r) => a + r.price.platformFeePaise, 0);

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <h1>Operations</h1>
      <p className="sub">Bookings, supply and the ledger.</p>

      <div className="row" style={{ marginBottom: 18 }}>
{/*
          "Verify" and "Purohits" were indistinguishable to anyone looking for a
          pandit to approve — and the one that does nothing had the more obvious
          name. Labels now say what the tab is FOR, and the queue carries a count.
        */}
        {([
          ['bookings', 'Bookings'],
          ['incidents', 'Cancellations'],
          ['verify', queue.length > 0 ? `Approvals (${queue.length})` : 'Approvals'],
          ['purohits', 'All pandits'],
          ['ledger', 'Ledger'],
        ] as Array<[Tab, string]>).map(([t, label]) => (
          <button key={t} className={tab === t ? 'sm' : 'ghost sm'} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        <button className="btn outline sm" onClick={load}>Refresh</button>
      </div>

      {err && <div className="notice err">{err}</div>}

      {tab === 'bookings' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="card" style={{ minWidth: 150 }}>
              <div className="muted" style={{ fontSize: 12 }}>Commission captured</div>
              <div className="stat" style={{ fontSize: '1.6rem' }}>{rs(feeCaptured)}</div>
              <div className="muted" style={{ fontSize: 11 }}>token collected up front, cash or not</div>
            </div>
            {Object.entries(byState).map(([s, n]) => (
              <div className="card" key={s} style={{ minWidth: 120 }}>
                <div className="muted" style={{ fontSize: 12 }}>{STATE_LABEL[s] ?? s}</div>
                <div className="stat" style={{ fontSize: '1.6rem' }}>{n}</div>
              </div>
            ))}
          </div>

          <div className="table-wrap"><table>
            <thead><tr>
              <th>Ritual</th><th>When</th><th>Purohit</th><th>Devotee</th>
              <th>State</th><th>Pay</th><th className="num">Total</th><th className="num">Fee</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.ritualSlug}</td>
                  <td>{prettyDate(r.date)}</td>
                  <td>{r.panditName ?? r.panditPhone}</td>
                  <td>{r.devoteeName ?? r.devoteePhone}</td>
                  <td><span className="tag">{STATE_LABEL[r.state] ?? r.state}</span></td>
                  <td>{r.paymentMode === 'cash' ? 'Cash' : 'Online'}</td>
                  <td className="num">{rs(r.price.totalPaise)}</td>
                  <td className="num">{rs(r.price.platformFeePaise)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {rows.length === 0 && <p className="muted">No bookings yet.</p>}
        </>
      )}

      {tab === 'incidents' && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Every cancellation and every automatic substitution. The ones marked{' '}
            <strong>needs a purohit</strong> are bookings the re-match could not
            save — a devotee with no purohit and a slot getting closer.
          </p>
          {incidents.length === 0 && (
            <div className="card"><p className="muted" style={{ margin: 0 }}>
              Nothing cancelled or re-matched yet.
            </p></div>
          )}
          <ul className="inc">
            {incidents.map((i) => (
              <li key={i.id} className={i.needsAttention ? 'inc-row bad' : 'inc-row'}>
                <span className="inc-kind">
                  {i.kind === 'substituted' ? 'Re-matched'
                    : i.kind === 'pandit_cancelled' ? 'Pandit dropped'
                    : 'Devotee cancelled'}
                </span>
                <span className="inc-main">
                  <span className="inc-who">{i.devoteeName ?? 'A devotee'}</span>
                  <span className="inc-when muted">
                    puja on {new Date(i.slotStartAt).toLocaleString('en-IN', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  {i.reason && <span className="inc-reason muted">“{i.reason}”</span>}
                </span>
                <span className="inc-state">
                  {i.needsAttention
                    ? <span className="tag avoid">Needs a purohit</span>
                    : i.rescued
                      ? <span className="tag auspicious">Covered automatically</span>
                      : <span className="muted">Closed</span>}
                </span>
                <span className="inc-at muted">
                  {new Date(i.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'verify' && (
        <>
          <p className="sub">
            KYC is reviewed by a person, not a vendor integration — at roughly one a day
            that is ten minutes of work, and the judgement that matters (is this a
            credible purohit, is the lineage real) is not automatable. Every decision is
            audit-logged.
          </p>
          {queue.length === 0 && <p className="muted">Queue is empty — nobody is waiting.</p>}
          <div className="grid c2">
            {queue.map((p) => (
              <div className="card" key={p.id}>
                <div className="spread">
                  <strong>{p.name ?? p.phone}</strong>
                  <span className="tag avoid">{p.kycStatus}</span>
                </div>
                <div className="muted" style={{ fontSize: 13, margin: '6px 0 12px' }}>
                  {p.experienceYears} years · {languageNames(p.languages).join(', ')}
                  {p.traditions?.length > 0 && ` · ${traditionNames(p.traditions).join(', ')}`}
                  <br />{p.documents} document(s) uploaded
                </div>

                {/*
                  Until this existed there was nothing to look at: nothing in the
                  product could create a `kyc_records` row, so this count rendered
                  zero for everyone and Approve was a rubber stamp on a name and a
                  self-declared number of years.
                */}
                {docs[p.id] ? (
                  <ul className="kyc-review">
                    {docs[p.id]!.map((d) => (
                      <li key={d.id}>
                        <span className="kind">{d.type}</span>
                        {d.last4 && <span className="muted"> ····{d.last4}</span>}
                        {d.viewUrl
                          ? (
                            <a href={d.viewUrl} target="_blank" rel="noreferrer noopener">
                              Open
                            </a>
                          )
                          : <span className="muted"> · image purged</span>}
                      </li>
                    ))}
                  </ul>
                ) : p.documents > 0 && (
                  <button className="linkish" onClick={() => void openDocuments(p.id)}>
                    View {p.documents} document{p.documents === 1 ? '' : 's'}
                  </button>
                )}

                <div className="row">
                  <button className="btn" disabled={busy === p.id || p.documents === 0}
                          title={p.documents === 0 ? 'Nothing has been submitted to review' : undefined}
                          onClick={() => decide(p.id, 'verified')}>Approve</button>
                  <button className="btn ghost" disabled={busy === p.id}
                          onClick={() => decide(p.id, 'rejected')}>Reject</button>
                </div>
                {rowErr[p.id] && (
                  <div className="notice err" style={{ marginBottom: 0 }}>{rowErr[p.id]}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'purohits' && (
        <div className="table-wrap"><table>
          <thead><tr>
            <th>Name</th><th>Phone</th><th>KYC</th><th className="num">Years</th>
            <th className="num">Reviews</th><th>Languages</th><th>Cash jobs</th>
            <th>Action</th>
          </tr></thead>
          <tbody>
            {purohits.map((p) => (
              <tr key={p.id}>
                <td>{p.name ?? '—'}</td>
                <td className="mono">{p.phone}</td>
                <td>
                  <span className={`tag ${p.kycStatus === 'verified' ? 'auspicious' : 'avoid'}`}>
                    {p.kycStatus}
                  </span>
                </td>
                <td className="num">{p.experienceYears}</td>
                <td className="num">{p.ratingCount}</td>
                <td>{languageNames(p.languages).join(', ')}</td>
                <td>{p.cashJobsEnabled ? 'enabled' : 'paused'}</td>
                <td>
                  {/* Approving from here saves a trip to another tab, which is
                      where everyone was getting stuck. */}
                  {p.kycStatus !== 'verified' ? (
                    <div className="row">
                      <button className="btn sm" disabled={busy === p.id}
                              onClick={() => decide(p.id, 'verified')}>Approve</button>
                      <button className="btn ghost sm" disabled={busy === p.id}
                              onClick={() => decide(p.id, 'rejected')}>Reject</button>
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {rowErr[p.id] && (
                    <div className="notice err" style={{ margin: '8px 0 0', fontSize: '.82rem' }}>
                      {rowErr[p.id]}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {tab === 'ledger' && ledger && (
        <>
          <div className={ledger.unbalancedTransactions === 0 ? 'notice ok' : 'notice err'}>
            {ledger.unbalancedTransactions === 0
              ? 'Every transaction balances. Debits equal credits across the whole book.'
              : `${ledger.unbalancedTransactions} unbalanced transaction(s) — this should be impossible; page someone.`}
          </div>
          <p className="sub">
            Append-only, double-entry. Balances are derived from these rows, never stored —
            there is no balance column anywhere in the schema.
          </p>
          <div className="table-wrap"><table>
            <thead><tr>
              <th>When</th><th>Txn</th><th>Account</th><th>Type</th>
              <th>Dir</th><th className="num">Amount</th>
            </tr></thead>
            <tbody>
              {ledger.entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{new Date(e.at).toLocaleString('en-IN')}</td>
                  <td className="mono">{e.txnId.slice(-8)}</td>
                  <td>{e.ownerType}</td>
                  <td><span className="tag">{e.type}</span></td>
                  <td style={{ color: e.direction === 'debit' ? 'var(--err)' : 'var(--ok)' }}>
                    {e.direction}
                  </td>
                  <td className="num">{rs(e.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {ledger.entries.length === 0 && <p className="muted">No ledger entries yet.</p>}
        </>
      )}
    </div>
  );
}
