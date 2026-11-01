'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * The community moderation queue.
 *
 * Built because C1 shipped without it: triage could set a post to `held` and nothing
 * in the product could release one, which made an automatic hold indistinguishable
 * from a deletion — the one outcome ADR 0016 says must never happen here.
 *
 * ORDERED BY WAIT, not by severity, and the wait is shown on every row. Both clocks
 * are obligations: a held post is a devotee wondering whether their question exists,
 * and an open report is the Information Technology Rules' 24-hour acknowledgement
 * window. A queue that sorts by anything else lets the oldest item age out quietly,
 * which is exactly the failure the SLA exists to prevent.
 */

interface Held {
  id: string; kind: string; title: string | null; body: string;
  locale: string; held_at: string; held_reason: string | null;
  display_name: string; space_slug: string;
}

interface Report {
  id: string; post_id: string; reason: string; note: string | null;
  created_at: string; title: string | null; body: string;
  locale: string; post_state: string; author_name: string;
}

interface Queue {
  held: Held[];
  reports: Report[];
  /** Sent with the queue rather than restated here — they are configuration. */
  sla: { ackHours: number; resolveDays: number };
}

/**
 * How long it has been waiting, in the units a reviewer thinks in.
 *
 * Deliberately relative and deliberately not `toLocaleString`: "4 days" is the fact
 * that matters against an SLA, and an absolute timestamp makes the reader do the
 * subtraction on every row.
 */
function waited(iso: string): { label: string; hours: number } {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return { label: 'just now', hours };
  if (hours < 24) return { label: `${Math.floor(hours)}h`, hours };
  return { label: `${Math.floor(hours / 24)}d`, hours };
}

export function ModerationQueue() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try { setQueue(await api<Queue>('/v1/admin/community/queue')); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr(null);
    try { await fn(); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  if (!queue) return <p className="muted">Loading the queue…</p>;

  const { held, reports, sla } = queue;

  return (
    <>
      <p className="sub">
        Held posts and open reports, oldest first. Nothing here was deleted — a hold
        means a person has not looked yet. Acknowledge a report within{' '}
        <strong>{sla.ackHours} hours</strong> and resolve it within{' '}
        <strong>{sla.resolveDays} days</strong>.
      </p>

      {err && <div className="notice err">{err}</div>}

      <h3 className="mq-head">
        Held posts {held.length > 0 && <span className="tag avoid">{held.length}</span>}
      </h3>
      {held.length === 0 && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>
          Nothing held. Every post written so far went straight through.
        </p></div>
      )}
      <ul className="mq-list">
        {held.map((p) => {
          const w = waited(p.held_at);
          return (
            <li key={p.id} className={`mq-row${w.hours > 24 ? ' stale' : ''}`}>
              <div className="mq-meta">
                <span className="tag">{p.held_reason ?? 'flagged'}</span>
                <span className="muted">{p.space_slug}</span>
                <span className="muted">· {p.display_name}</span>
                <span className="mq-wait" title="Waiting">{w.label}</span>
              </div>
              {/* `lang` so the reviewer's browser typesets it correctly — this is
                  the one screen guaranteed to show scripts the reader may not use. */}
              {p.title && <p className="mq-title" lang={p.locale}>{p.title}</p>}
              <p className="mq-body" lang={p.locale}>{p.body}</p>
              <div className="mq-actions">
                <button
                  className="btn sm" disabled={busy === p.id}
                  onClick={() => void act(p.id, () => api(`/v1/admin/community/posts/${p.id}/decision`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ decision: 'release' }),
                  }))}
                >
                  Publish it
                </button>
                <RemoveButton
                  postId={p.id} busy={busy === `${p.id}-rm`}
                  onRemove={(reason) => act(`${p.id}-rm`, () =>
                    api(`/v1/admin/community/posts/${p.id}/decision`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ decision: 'remove', reason }),
                    }))}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <h3 className="mq-head">
        Reports {reports.length > 0 && <span className="tag avoid">{reports.length}</span>}
      </h3>
      {reports.length === 0 && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>
          No open reports.
        </p></div>
      )}
      <ul className="mq-list">
        {reports.map((r) => {
          const w = waited(r.created_at);
          return (
            <li key={r.id} className={`mq-row${w.hours > sla.ackHours ? ' stale' : ''}`}>
              <div className="mq-meta">
                <span className="tag avoid">{r.reason.replace(/_/g, ' ')}</span>
                <span className="muted">· {r.author_name}</span>
                <span className="muted">· post is {r.post_state}</span>
                <span className="mq-wait" title="Waiting">{w.label}</span>
              </div>
              {r.title && <p className="mq-title" lang={r.locale}>{r.title}</p>}
              <p className="mq-body" lang={r.locale}>{r.body}</p>
              {r.note && <p className="mq-note">Reporter said: “{r.note}”</p>}
              <div className="mq-actions">
                {/*
                  * Acknowledge is its own button because it is its own obligation.
                  * An operator who has read this at 9am but wants a second opinion
                  * has met the 24-hour duty and not the 15-day one, and collapsing
                  * them would understate compliance on the reports handled with the
                  * most care.
                  */}
                <button
                  className="btn outline sm" disabled={busy === `${r.id}-ack`}
                  onClick={() => void act(`${r.id}-ack`, () =>
                    api(`/v1/admin/community/reports/${r.id}/acknowledge`, { method: 'POST' }))}
                >
                  Acknowledge
                </button>
                <button
                  className="btn sm" disabled={busy === `${r.id}-act`}
                  onClick={() => void act(`${r.id}-act`, () =>
                    api(`/v1/admin/community/reports/${r.id}/resolution`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ state: 'actioned' }),
                    }))}
                >
                  Actioned
                </button>
                <button
                  className="btn ghost sm" disabled={busy === `${r.id}-rej`}
                  onClick={() => void act(`${r.id}-rej`, () =>
                    api(`/v1/admin/community/reports/${r.id}/resolution`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ state: 'rejected' }),
                    }))}
                >
                  Post stands
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Removal asks for the reason before it will proceed.
 *
 * The API refuses a removal without one, so a button that posted without asking
 * would simply fail. Asking here is also the point at which a reviewer decides
 * whether they can articulate why — which is usually the moment a borderline
 * removal turns back into a release.
 */
function RemoveButton({
  postId, busy, onRemove,
}: { postId: string; busy: boolean; onRemove: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button className="btn ghost sm" onClick={() => setOpen(true)} disabled={busy}>
        Remove it
      </button>
    );
  }

  return (
    <span className="mq-remove">
      <input
        autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="Why? The author reads this."
        aria-label={`Reason for removing post ${postId}`}
      />
      <button
        className="btn sm" disabled={busy || reason.trim().length < 3}
        onClick={() => { onRemove(reason.trim()); setOpen(false); setReason(''); }}
      >
        Remove
      </button>
      <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}
