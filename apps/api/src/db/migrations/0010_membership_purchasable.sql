-- Whether a plan can actually be bought.
--
-- `active` already says "show this offer". It does not say "money can change hands
-- for it", and those are genuinely different states right now: the membership has a
-- price and a discount, but nothing charges for it and nothing enforces the discount
-- at booking time. A Join button wired up today would take ₹1,499 for a benefit the
-- pricing engine does not apply.
--
-- Defaulting to FALSE is the point. The card renders a real plan with real numbers
-- and an honest call to action, and flipping this to TRUE is the deliberate act that
-- happens once checkout and entitlement exist — rather than the button quietly
-- working before the thing behind it does.

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS purchasable BOOLEAN NOT NULL DEFAULT FALSE;
