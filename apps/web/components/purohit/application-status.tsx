'use client';

import type { KycStage } from './kyc';

/**
 * Where the application stands, and roughly how long the rest takes.
 *
 * A purohit who had sent their documents saw a status chip reading "With our team"
 * and nothing else: no sense of what happens next, no idea whether two days or two
 * weeks was normal, and no way to tell whether they had missed a step. That silence
 * is what makes someone message support, or give up.
 *
 * The stage is decided by the API, not here. The rules behind it — which documents
 * are required, what a flagged document means, what blocks submission — all live on
 * that side, and a second copy of them in the browser is a second copy to drift.
 */

const STAGES: Array<{ id: KycStage; label: string; note: string }> = [
  { id: 'collecting', label: 'Your details', note: 'Profile, qualification and documents.' },
  { id: 'in_review', label: 'We check them', note: 'A person reads every document by hand.' },
  { id: 'approved', label: 'You can be booked', note: 'Devotees can see you and book you.' },
];

/**
 * Which of the three steps is current.
 *
 * `ready_to_submit` is still the first step — nothing has reached us. `action_needed`
 * is deliberately mapped back onto review rather than forward: the application is
 * with us, and it is waiting on them.
 */
const POSITION: Record<KycStage, number> = {
  collecting: 0,
  ready_to_submit: 0,
  in_review: 1,
  action_needed: 1,
  declined: 1,
  approved: 2,
};

export function ApplicationStatus({
  stage, reviewTargetHours,
}: {
  stage: KycStage;
  reviewTargetHours: number;
}) {
  const at = POSITION[stage];
  const days = Math.max(1, Math.round(reviewTargetHours / 24));

  return (
    <section className="appstat" aria-label="Your application">
      <div className="appstat-head">
        <h2>Your application</h2>
        <span className={`appstat-chip ${stage}`}>{HEADLINE[stage]}</span>
      </div>

      <ol className="appstat-track">
        {STAGES.map((s, i) => (
          <li key={s.id} className={i < at ? 'done' : i === at ? 'now' : ''}>
            <span className="dot" aria-hidden="true" />
            <div>
              <strong>{s.label}</strong>
              <span className="muted">{s.note}</span>
            </div>
          </li>
        ))}
      </ol>

      {/*
        Stated, not left to be guessed. It comes from the API so this screen and the
        WhatsApp message quote the same number, and it is framed as the usual case
        rather than a promise we cannot keep on a festival week.
      */}
      <p className="appstat-sla">
        {stage === 'approved'
          ? 'Nothing further is needed from you.'
          : stage === 'action_needed'
            ? `We need one thing from you before we can finish — see below. Once you send it, checking usually takes up to ${days} working ${days === 1 ? 'day' : 'days'}.`
            : `Checking usually takes up to ${days} working ${days === 1 ? 'day' : 'days'} from the moment you send your documents.`}
      </p>
    </section>
  );
}

/** What the chip says. Plain about whose turn it is. */
const HEADLINE: Record<KycStage, string> = {
  collecting: 'Not sent yet',
  ready_to_submit: 'Ready to send',
  in_review: 'With our team',
  action_needed: 'Needs your reply',
  approved: 'Approved',
  declined: 'Not approved',
};
