-- Asking for one document again, without rejecting the whole application.
--
-- Review was all-or-nothing: approve, or reject everything. A reviewer who could not
-- read one PAN card had to reject the application, and the purohit — told only
-- "rejected" — re-uploaded all four documents to fix one. Most review outcomes are
-- not "no", they are "send that one again".
--
-- `changes_requested` is that state: still under review, still theirs to fix, and
-- distinct from `rejected`, which is a decision we have actually made.
ALTER TYPE kyc_status ADD VALUE IF NOT EXISTS 'changes_requested';

-- When the purohit handed it to us, as opposed to when they signed up.
--
-- The review queue ordered by `pandit_profiles.created_at` — the signup date — so a
-- purohit who joined months ago and submitted this morning sat above someone who did
-- both yesterday. A work queue has to be ordered by when the work arrived.
ALTER TABLE pandit_profiles ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- Backfill: anything already waiting is ordered by signup date, which is the only
-- submission signal that exists for rows written before this column.
UPDATE pandit_profiles
   SET submitted_at = created_at
 WHERE submitted_at IS NULL AND kyc_status IN ('submitted', 'verified', 'rejected');
