'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Two switches that belong beside the job list, not inside a settings form.
 *
 * AUTO-ACCEPT. THE BUG THIS FIXES: the dashboard has advised turning this on since
 * the dashboard shipped, with a "Fix this" link to a page fragment that was never a
 * control for it — `pandit_profiles.auto_accept` (ADR 0011) has existed the whole
 * time with no way to set it from the product. It governs how a MATCHED JOB is
 * handled, which is what this page is about, so it lives here rather than on a
 * profile form about who the purohit is.
 *
 * AVAILABILITY. Moved from the wizard's last step, where "open my calendar" sat
 * behind four other screens a purohit had already finished. It is a single action
 * with no fields to fill in, so it earns a button here rather than a page of its own.
 */
export function QuickActions() {
  const [autoAccept, setAutoAccept] = useState<boolean | null>(null);
  const [busyToggle, setBusyToggle] = useState(false);
  const [slotsOpen, setSlotsOpen] = useState<number | null>(null);
  const [busyCalendar, setBusyCalendar] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ profile: { autoAccept: boolean } | null }>('/v1/me/purohit/profile')
      .then((r) => setAutoAccept(Boolean(r.profile?.autoAccept)))
      // Left at `null` rather than guessed as `false` — the switch stays disabled
      // until this resolves, instead of silently showing an "off" that might be
      // wrong and leading a purohit to believe a setting changed when it never did.
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const toggle = async () => {
    if (autoAccept === null) return;
    setBusyToggle(true); setErr(null);
    const next = !autoAccept;
    try {
      await api('/v1/me/purohit/auto-accept', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next }),
      });
      setAutoAccept(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyToggle(false);
    }
  };

  const openCalendar = async () => {
    setBusyCalendar(true); setErr(null);
    try {
      const r = await api<{ slotsOpen: number }>('/v1/me/purohit/availability', { method: 'POST' });
      setSlotsOpen(r.slotsOpen);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCalendar(false);
    }
  };

  return (
    <section className="quick-actions">
      {err && <div className="notice err">{err}</div>}

      <div className="qa-row">
        <div>
          <strong>Accept matched jobs automatically</strong>
          <span className="muted">
            {' '}Off means every request waits for you to say yes. On, it is confirmed
            the moment it is offered.
          </span>
        </div>
        <button
          type="button" role="switch" aria-checked={autoAccept ?? false}
          className={`qa-switch${autoAccept ? ' on' : ''}`}
          disabled={autoAccept === null || busyToggle}
          onClick={() => void toggle()}
        >
          <span className="qa-knob" />
        </button>
      </div>

      <div className="qa-row">
        <div>
          <strong>Your calendar</strong>
          <span className="muted">
            {' '}{slotsOpen !== null
              ? `${slotsOpen} slots open over the next 120 days.`
              : 'Open every slot for the next 120 days. Close individual days afterwards.'}
          </span>
        </div>
        <button className="btn outline sm" disabled={busyCalendar} onClick={() => void openCalendar()}>
          {busyCalendar ? 'Opening…' : 'Open calendar'}
        </button>
      </div>
    </section>
  );
}
