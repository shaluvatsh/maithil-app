-- Continuous-time scheduling: the schema half. See ADR 0013.
--
-- Deliberately ADDITIVE. `slot_idx` / `slot_span` and `pandit_weekly_patterns` stay
-- exactly as they are: allocation, search, the purohit calendar and the devotee
-- picker all still read them, and dropping them here would break every one of those
-- at once. They are retired in the steps that move the logic across, not in the step
-- that prepares the ground.

-- 1. NO TWO LIVE BOOKINGS FOR ONE PUROHIT MAY OVERLAP --------------------------
--
-- Today the guarantee is indirect: `SlotService.lockAndBook` takes `FOR UPDATE`
-- over discrete `availability` rows and a unique index backstops it. Once bookings
-- occupy arbitrary intervals there are no discrete rows to lock, so the guarantee
-- has to move onto the interval itself.
--
-- Scoped to `confirmed` and `in_progress` — the states where a purohit is actually
-- committed and the time has not yet passed. Deliberately NOT `completed`: a
-- finished booking is history and cannot conflict with future scheduling, and
-- including it would let any historical data-quality problem block the constraint
-- permanently. (An audit before writing this found exactly one such pair, a
-- completed booking overlapping a confirmed one, and zero overlaps among live
-- states.)
--
-- Also NOT `pending_accept`, for now. Under the current flow the slot is locked at
-- PAYMENT, not at submit, so two devotees can legitimately hold `pending_accept`
-- bookings for the same purohit and slot and one loses at capture — the race the
-- auto-refund in `payments.service.ts` exists to settle. Extending the constraint
-- to cover it would move that rejection earlier, which is better for the devotee,
-- but it is a behavioural change belonging with the allocation rewrite rather than
-- with a schema migration.
--
-- `btree_gist` is already installed (9999_guards.sql, for panchang_intervals).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_pandit_no_overlap"
  EXCLUDE USING gist (
    "pandit_id" WITH =,
    tstzrange("slot_start_at", "slot_end_at") WITH &&
  ) WHERE ("state" IN ('confirmed', 'in_progress'));
--> statement-breakpoint

-- 2. WORKING HOURS AS TIME WINDOWS --------------------------------------------
--
-- `pandit_weekly_patterns` says "I work slot 2 on Tuesdays", which cannot express
-- 22:00–03:00 — and the catalogue already sells a midnight Kali Puja and a
-- four-prahar Shiva Ratri that need exactly that.
--
-- Several rows per weekday are allowed, so a split day (mornings and evenings, not
-- the afternoon) is a natural two rows rather than a special case.
--
-- CROSSING MIDNIGHT: `ends_at <= starts_at` means the window runs into the next
-- day, the convention shift rosters use. 22:00–03:00 is one row, not two, and the
-- reader expands it to concrete instants.
CREATE TABLE IF NOT EXISTS "pandit_working_hours" (
  "pandit_id"  text NOT NULL REFERENCES "pandit_profiles"("user_id") ON DELETE CASCADE,
  "weekday"    integer NOT NULL,
  "starts_at"  time NOT NULL,
  "ends_at"    time NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("pandit_id", "weekday", "starts_at"),
  -- 0 = Sunday, matching JS getDay() and Postgres EXTRACT(DOW), as the slot-based
  -- table it replaces already did.
  CONSTRAINT "pandit_working_hours_weekday" CHECK ("weekday" BETWEEN 0 AND 6)
);
--> statement-breakpoint

-- 3. PER-DATE OVERRIDES, FOR FESTIVALS AND DAYS OFF ---------------------------
--
-- Durga Puja is not a busy Tuesday. A purohit may work 04:00–01:00 across the
-- festival, and may perform at six homes in one para where a 30-minute travel floor
-- that is right on a normal day would silently cap them at a third of the work they
-- can actually do. Both are properties of a DATE, not of a weekday.
--
-- The same table serves the opposite case: `is_available = false` is a day off.
--
-- Any row here replaces the weekly pattern for that date entirely — an override is
-- a statement about the whole day, not an addition to it.
CREATE TABLE IF NOT EXISTS "pandit_date_overrides" (
  "pandit_id"            text NOT NULL REFERENCES "pandit_profiles"("user_id") ON DELETE CASCADE,
  "date"                 date NOT NULL,
  "is_available"         boolean NOT NULL DEFAULT true,
  -- NULL = use the region's default floor. Set lower for a festival round where the
  -- homes are minutes apart; the estimate handles the distance, only the floor needs
  -- the purohit's own knowledge of their para.
  "travel_floor_minutes" integer,
  "note"                 text,
  "updated_at"           timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("pandit_id", "date"),
  CONSTRAINT "pandit_date_overrides_floor_range"
    CHECK ("travel_floor_minutes" IS NULL
           OR ("travel_floor_minutes" >= 0 AND "travel_floor_minutes" <= 240))
);
--> statement-breakpoint

-- The windows for an overridden date. Absent while `is_available` is false; one row
-- per window otherwise, same midnight-crossing convention as the weekly table.
CREATE TABLE IF NOT EXISTS "pandit_date_windows" (
  "pandit_id" text NOT NULL,
  "date"      date NOT NULL,
  "starts_at" time NOT NULL,
  "ends_at"   time NOT NULL,
  PRIMARY KEY ("pandit_id", "date", "starts_at"),
  FOREIGN KEY ("pandit_id", "date")
    REFERENCES "pandit_date_overrides"("pandit_id", "date") ON DELETE CASCADE
);
--> statement-breakpoint

-- The allocation read: "this purohit's live bookings on this date, in order", which
-- is how the travel check finds the neighbours either side of a requested window.
CREATE INDEX IF NOT EXISTS "bookings_pandit_start_idx"
  ON "bookings" ("pandit_id", "slot_start_at");
