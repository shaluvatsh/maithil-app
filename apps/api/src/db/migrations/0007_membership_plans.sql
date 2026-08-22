-- Membership plans.
--
-- The home page advertised "Festival Booking + Family Membership Plan — 18% OFF,
-- save up to ₹2,099, bundle from ₹9,399, 145 days left". Every one of those was a
-- string literal in a React component. Nobody could buy it, no ledger account
-- existed for it, and the countdown counted down from nothing. An offer a customer
-- cannot accept is not a pricing decision, it is a lie rendered in a gradient.
--
-- This is the smallest honest version: a plan is a row, with a price, a duration
-- and an end date, and the page renders what the row says or renders nothing.

CREATE TABLE IF NOT EXISTS membership_plans (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  tagline          TEXT NOT NULL DEFAULT '',
  price_paise      BIGINT NOT NULL,
  -- How long the membership lasts once bought, not how long it is on sale.
  duration_days    INTEGER NOT NULL,
  -- Applied to the ritual subtotal of a booking made by a member. Basis points, so
  -- 1200 is 12%; a percentage stored as a float is how rounding disputes start.
  discount_bps     INTEGER NOT NULL CHECK (discount_bps BETWEEN 0 AND 5000),
  -- What the member actually gets. Rendered as-is, so it cannot drift from the
  -- price the way the hardcoded copy did.
  benefits         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- NULL means "on sale indefinitely". A date here is what the countdown reads.
  offer_ends_on    DATE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The home page asks for "the current offer" and nothing else, so this is the
-- predicate that actually runs. A btree on `active` alone would not serve it.
CREATE INDEX IF NOT EXISTS membership_plans_live_idx
  ON membership_plans (active, offer_ends_on)
  WHERE active;

-- Per-city price override. A membership priced for Mumbai is not priced for
-- Patna, and the ritual catalogue already varies by city through
-- ritual_city_prices; a single national number would be the odd one out.
CREATE TABLE IF NOT EXISTS membership_city_prices (
  plan_id      TEXT NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
  city_id      TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  price_paise  BIGINT NOT NULL,
  PRIMARY KEY (plan_id, city_id)
);
