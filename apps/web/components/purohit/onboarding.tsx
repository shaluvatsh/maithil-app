'use client';

import Link from 'next/link';
import { KycPanel } from './kyc';

/**
 * What a purohit sees before they are approved.
 *
 * They used to land on the full dashboard: a job inbox that cannot receive a job,
 * ₹0 earnings that cannot change, and a calendar nobody can book — because devotees
 * only ever match a `verified` purohit. Three dead panels, none of which said why
 * they were dead, above the one thing that actually moves them forward.
 *
 * So until they are approved this screen replaces the dashboard entirely, and shows
 * only what they can act on: finish the profile, send the documents, wait for us.
 * The dashboard appears when it has something true to show.
 */
export function PurohitOnboarding({
  kycStatus, profileComplete,
}: {
  kycStatus: string;
  /** Whether they have said what they perform and what they charge. */
  profileComplete: boolean;
}) {
  const submitted = kycStatus === 'submitted';
  const rejected = kycStatus === 'rejected';
  /** We asked for something back. Their turn, not ours — and not a rejection. */
  const asked = kycStatus === 'changes_requested';

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px' }}>
      <h1>Welcome to TheMaithil</h1>
      <p className="sub">
        Two things stand between you and your first booking. Neither takes long.
      </p>

      {/*
        The waiting state is the one most likely to be misread as "nothing is
        happening". Say who has it and roughly how long, so nobody refreshes for
        two days wondering whether they missed a step.
      */}
      {submitted && (
        <div className="notice ok" style={{ marginTop: 18 }}>
          <strong>Your documents are with our team.</strong> We check them by hand,
          usually within two working days. We will message you on WhatsApp the moment
          it is done — there is nothing further for you to do.
        </div>
      )}
      {asked && (
        <div className="notice warn" style={{ marginTop: 18 }}>
          <strong>We need one thing from you.</strong> A document did not come through
          clearly enough to check. The panel below says which one and why — replace
          just that one and send it back. Nothing else you sent needs re-doing.
        </div>
      )}
      {rejected && (
        <div className="notice err" style={{ marginTop: 18 }}>
          <strong>We could not approve your account yet.</strong> The notes under each
          document below explain what we need. Replace what is flagged and send it
          again — this happens often and it is not a rejection of you.
        </div>
      )}

      <ol className="onb-steps">
        <li className={profileComplete ? 'done' : 'now'}>
          <div>
            <strong>Your profile</strong>
            <span className="muted">
              {profileComplete
                ? 'What you perform, what you charge, and when you are free.'
                : 'Tell us what you perform, what you charge, and when you are free.'}
            </span>
          </div>
          <Link href="/purohit/setup" className="btn outline sm">
            {profileComplete ? 'Edit' : 'Start'}
          </Link>
        </li>
        <li className={kycStatus === 'verified' ? 'done' : submitted ? 'wait' : 'now'}>
          <div>
            <strong>Your documents</strong>
            <span className="muted">
              Devotees only see purohits we have checked by hand.
            </span>
          </div>
        </li>
      </ol>

      <KycPanel />

      <p className="muted" style={{ fontSize: '.88rem', marginTop: 24 }}>
        Your jobs, calendar and earnings appear here once you are approved.
      </p>
    </div>
  );
}
