-- ---------------------------------------------------------------------------
-- Hand-written guards. Applied AFTER the drizzle-kit generated migrations.
-- These are the constraints that make the money paths safe. They are deliberately
-- in SQL and deliberately redundant with the application layer: an ORM bug, a bad
-- migration or a psql session should not be able to corrupt the ledger.
-- ---------------------------------------------------------------------------

-- 1. LEDGER INVARIANT: every transaction balances. -----------------------------
-- Checked at COMMIT (DEFERRED), so a service can insert the debit and credit legs
-- in any order within a transaction, but cannot commit an unbalanced set.
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE
  imbalance BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_paise ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_paise ELSE 0 END), 0)
    INTO imbalance
    FROM ledger_entries
   WHERE txn_id = COALESCE(NEW.txn_id, OLD.txn_id);

  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'ledger transaction % is unbalanced by % paise', COALESCE(NEW.txn_id, OLD.txn_id), imbalance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- Money is always positive; direction carries the sign.
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_amount_positive CHECK (amount_paise > 0);

-- The ledger is append-only. Corrections are new compensating entries, never edits.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; post a compensating entry instead'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();


-- 2. SURGE CAP, enforced by the database, not by application logic. -------------
ALTER TABLE surge_rules
  ADD CONSTRAINT surge_within_bounds
  CHECK (multiplier_bps >= 10000 AND multiplier_bps <= 15000);

-- ritual_id IS NULL means "city-wide". A plain UNIQUE treats NULLs as distinct,
-- which would let two conflicting city-wide rules exist for one date.
CREATE UNIQUE INDEX surge_rules_citywide_uniq
  ON surge_rules (city_id, date) WHERE ritual_id IS NULL;


-- 3. BOOKING SANITY ------------------------------------------------------------
-- A span is at least one slot, and no more than a whole day.
--
-- This used to read `slot_idx + slot_span <= 4` — Kolkata's four-slot day, written
-- into the schema as though it were a property of bookings. It refused evening
-- bookings outright in the five-slot southern cities, and it capped how long a
-- ritual could be: a full Chandi Paath spans most of a day and could only start at
-- dawn. Overlap is guaranteed by `bookings_pandit_no_overlap` (migration 0018), an
-- exclusion constraint over the real interval, which does not care how a city
-- divides its day. See A0001_long_rituals.sql, which applies this to databases
-- built before it changed here.
ALTER TABLE bookings
  ADD CONSTRAINT booking_slot_span_valid
  CHECK (slot_span >= 1 AND slot_span <= 8);

ALTER TABLE bookings
  ADD CONSTRAINT booking_window_ordered
  CHECK (slot_end_at > slot_start_at);

-- Cash bookings must record what was collected once completed.
ALTER TABLE bookings
  ADD CONSTRAINT cash_completion_records_amount
  CHECK (
    state <> 'completed' OR payment_mode <> 'cash' OR cash_collected_paise IS NOT NULL
  );

-- A booking can only be attached to one availability row per slot; belt and braces
-- alongside the FOR UPDATE lock in BookingService.confirm().
CREATE UNIQUE INDEX availability_booking_slot_uniq
  ON availability (booking_id, slot_idx) WHERE booking_id IS NOT NULL;


-- 4. PANCHANG INTERVALS MUST NOT OVERLAP ---------------------------------------
-- Two tithis cannot be current at the same instant for one city+school. This is an
-- exclusion constraint rather than an application check because the nightly job and
-- a manual admin correction can race.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE panchang_intervals
  ADD CONSTRAINT panchang_intervals_no_overlap
  EXCLUDE USING gist (
    city_id WITH =,
    school  WITH =,
    kind    WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  );

ALTER TABLE panchang_intervals
  ADD CONSTRAINT panchang_interval_ordered CHECK (ends_at > starts_at);


-- 5. REVIEWS -------------------------------------------------------------------
ALTER TABLE reviews ADD CONSTRAINT review_stars_range CHECK (
  (pandit_stars       IS NULL OR pandit_stars       BETWEEN 1 AND 5) AND
  (punctuality_stars  IS NULL OR punctuality_stars  BETWEEN 1 AND 5) AND
  (samagri_stars      IS NULL OR samagri_stars      BETWEEN 1 AND 5) AND
  (devotee_stars      IS NULL OR devotee_stars      BETWEEN 1 AND 5)
);


-- 6. OUTBOX RELAY HOT PATH -----------------------------------------------------
-- Partial index: the relay only ever reads unpublished rows, and this table grows
-- forever. Without WHERE published_at IS NULL the index is useless within a month.
DROP INDEX IF EXISTS outbox_unpublished;
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
