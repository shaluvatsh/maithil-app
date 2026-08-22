-- Where a purohit's money actually goes.
--
-- `pandit_profiles.linked_account_id` has existed since the payments client was
-- written and NOTHING has ever set it. There was no bank or UPI capture anywhere in
-- onboarding or the profile, so `PayoutService` computed a correct net payable that
-- had no destination, while the earnings screen told the purohit "payouts run
-- weekly". The marketplace could take money from devotees and had no way to pay the
-- people doing the work.
--
-- WHAT IS AND IS NOT STORED HERE.
--
-- Never the account number. It goes to the payment provider once, in the call that
-- creates the linked account, and what comes back is an opaque id. That id is the
-- only thing worth holding: it is what a transfer is addressed to, it is useless to
-- anyone who steals this table, and it means a database dump is not a list of bank
-- accounts. The last four digits are kept so a purohit can recognise which account
-- they gave us, and the IFSC because it identifies a branch, not a person.
CREATE TYPE payout_method AS ENUM ('bank_account', 'upi');

ALTER TABLE pandit_profiles
  ADD COLUMN IF NOT EXISTS payout_method       payout_method,
  ADD COLUMN IF NOT EXISTS payout_holder_name  text,
  ADD COLUMN IF NOT EXISTS payout_last4        text,
  ADD COLUMN IF NOT EXISTS payout_ifsc         text,
  ADD COLUMN IF NOT EXISTS payout_upi_vpa      text,
  ADD COLUMN IF NOT EXISTS payout_linked_at    timestamptz;

-- Partial: the vast majority of rows are null until the purohit adds an account, and
-- the only question ever asked of this column is "who still has no destination?".
CREATE INDEX IF NOT EXISTS pandit_payout_pending_idx
  ON pandit_profiles (user_id) WHERE linked_account_id IS NULL;

COMMENT ON COLUMN pandit_profiles.payout_last4 IS
  'Display only. The full account number is never stored - see 0013 migration notes.';
