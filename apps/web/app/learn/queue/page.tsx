'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRegion } from '@/lib/region-context';
import { api, auth } from '@/lib/api';
import { fontPlan } from '@themaithil/region';
import { scriptOf } from '@/lib/community';

/**
 * The review queue.
 *
 * OPEN TO VERIFIED PUROHITS, not only to staff, and the blurb says so in as many
 * words: *"You are reading it because you can judge whether it is right — staff
 * cannot."* That is the only way this scales. Nobody on an operations team can tell
 * whether a Maithili account of a vidhi is correct, and the people who can are
 * already on the platform.
 *
 * Oldest first, with the wait shown, for the reason the moderation queue is ordered
 * that way: a queue sorted by anything else lets its oldest item age out quietly, and
 * here the oldest item is an author waiting to hear whether their work exists.
 */
interface QueueRow {
  id: string; slug: string; type: string; level: string;
  primary_locale: string; media_key: string | null; updated_at: string;
  author_name: string | null; author_kyc: string | null;
  title: string | null; summary: string | null; citation_count: number;
}

/** How long it has been waiting, in the unit a reviewer thinks in. */
function waited(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function ReviewQueuePage() {
  const { t } = useRegion();
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try { setRows(await api<QueueRow[]>('/v1/knowledge/queue')); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    if (!auth.token) { setErr(t('learn.signInToWrite')); setRows([]); return; }
    void load();
  }, [load, t]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr(null);
    try { await fn(); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <main className="wrap lr-wrap">
      <Link href="/learn" className="btn-link lr-back">← {t('learn.backToLearn')}</Link>
      <h1>{t('learn.queue')}</h1>
      <p className="muted lr-blurb">{t('learn.queueBlurb')}</p>

      {err && <p className="lr-notice">{err}</p>}
      {rows && rows.length === 0 && !err && (
        <p className="muted lr-empty">{t('learn.queueEmpty')}</p>
      )}

      <ul className="lr-queue">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="lr-qrow">
            <div className="lr-qmeta">
              <span className="tag">{r.type.replace(/_/g, ' ')}</span>
              <span className="muted">{r.author_name}</span>
              {r.author_kyc === 'verified' && <span className="lr-tick">✓</span>}
              {r.citation_count > 0 && <span className="muted">· {r.citation_count} 📚</span>}
              <span className="lr-qwait">{t('learn.queueWaiting', { time: waited(r.updated_at) })}</span>
            </div>

            {/* Typeset in the language it was written in — this is the one screen
                guaranteed to show a reviewer a script they may not use daily. */}
            <p className="lr-qtitle" lang={r.primary_locale}
               style={{ fontFamily: fontPlan(scriptOf(r.primary_locale)).vars.ui }}>
              {r.title}
            </p>
            <p className="lr-qsummary muted" lang={r.primary_locale}>{r.summary}</p>

            <div className="lr-qactions">
              {/* Read it before deciding: a reviewer who has only seen a summary is
                  not reviewing, and publishing on one is how the gate becomes theatre. */}
              <Link href={`/learn/${r.slug}`} className="btn outline sm">
                {t('learn.readGuide')}
              </Link>
              <button
                type="button" className="btn sm" disabled={busy === r.id}
                onClick={() => void act(r.id, () => api(`/v1/knowledge/${r.id}/review`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ decision: 'publish' }),
                }))}
              >
                {t('learn.publishIt')}
              </button>
              <SendBack
                id={r.id} busy={busy === `${r.id}-back`}
                onSend={(note) => act(`${r.id}-back`, () =>
                  api(`/v1/knowledge/${r.id}/review`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ decision: 'changes', note }),
                  }))}
              />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * Sending it back asks for the reason first.
 *
 * The API refuses a `changes` verdict without a note, so a button that posted
 * without one would simply fail. Asking here is also where a reviewer decides
 * whether they can say what is wrong — which is usually the moment a borderline
 * rejection turns into a publish.
 */
function SendBack({
  id, busy, onSend,
}: { id: string; busy: boolean; onSend: (note: string) => void }) {
  const { t } = useRegion();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn ghost sm" disabled={busy}
              onClick={() => setOpen(true)}>
        {t('learn.sendBack')}
      </button>
    );
  }

  return (
    <span className="lr-qback">
      <input
        autoFocus value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={t('learn.sendBackWhy')}
        aria-label={`${t('learn.sendBackWhy')} ${id}`}
      />
      <button
        type="button" className="btn sm" disabled={busy || note.trim().length < 3}
        onClick={() => { onSend(note.trim()); setOpen(false); setNote(''); }}
      >
        {t('learn.sendBack')}
      </button>
    </span>
  );
}
