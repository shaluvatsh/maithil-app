-- Multi-day rituals: a Durga Puja is four days, not a long afternoon.
--
-- `parent_booking_id` has been on `bookings` since the first migration, carrying the
-- comment "Multi-day rituals (Biye) are linked bookings in R1", and NOTHING has ever
-- written it. So the catalogue's answer to a four-day Durga Puja or a nine-day
-- Chandi Paath was a single row with a slot span, which is not what either of those
-- is: they are the same purohit, in the same house, at the same hour, on consecutive
-- days, each of which is performed and can independently go wrong.
--
-- HOW MANY DAYS is a property of the ritual, so it lives on the catalogue row rather
-- than being asked of the devotee. A family books "Durga Puja", not "four bookings".
--
-- Sorts after `9999_guards.sql` for the reason A0001 explains at length: a fresh
-- database applies every file in filename order, so anything amending a guard — or
-- landing near one — must outsort it.
ALTER TABLE "rituals" ADD COLUMN IF NOT EXISTS "days" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE "rituals"
  DROP CONSTRAINT IF EXISTS "ritual_days_sane";
--> statement-breakpoint

-- A fortnight is beyond anything the catalogue sells and well past what one purohit
-- can hold consecutively; more than that is a data-entry mistake, not a longer puja.
ALTER TABLE "rituals"
  ADD CONSTRAINT "ritual_days_sane" CHECK ("days" >= 1 AND "days" <= 16);
--> statement-breakpoint

-- The parent is a real booking — day one of the series, performed like any other —
-- not an empty umbrella row. So the reference is self-referential and nullable:
-- NULL means "this is day one, or a single-day booking", which is the overwhelming
-- majority of rows and needs no extra storage to say so.
--
-- ON DELETE is deliberately absent. Bookings are never deleted (cancellation is a
-- state, and the ledger references them), so a cascade rule here would describe
-- something that cannot happen.
ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "bookings_parent_fk";
--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_parent_fk"
  FOREIGN KEY ("parent_booking_id") REFERENCES "bookings"("id");
--> statement-breakpoint

-- A booking cannot be its own parent. Cheap, and it makes the "walk to the head of
-- the series" read below terminate by construction rather than by convention.
ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "booking_parent_not_self";
--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "booking_parent_not_self"
  CHECK ("parent_booking_id" IS NULL OR "parent_booking_id" <> "id");
--> statement-breakpoint

-- "Every day of this series, in order" is the read the whole feature rests on: the
-- devotee's booking view, the purohit's job card, and the confirm-the-whole-series
-- path all need it, and without an index each one scans the table.
CREATE INDEX IF NOT EXISTS "bookings_parent_idx"
  ON "bookings" ("parent_booking_id", "slot_start_at")
  WHERE "parent_booking_id" IS NOT NULL;
--> statement-breakpoint

-- When a later day's start code was issued and sent.
--
-- `SeriesCodesJob` REPLACES the stored hash when it sends, so running twice would
-- invalidate a code the devotee is already holding. That makes a `notifications`
-- lookup the wrong dedup — it can succeed while the update that matters did not.
-- Set in the same statement as the hash, so the two cannot drift.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "series_codes_sent_at" timestamp with time zone;
