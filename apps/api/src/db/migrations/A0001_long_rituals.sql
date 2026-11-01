-- Long rituals: lifting a ceiling that encoded one city's day.
--
-- FILENAME. This sorts AFTER `9999_guards.sql`, and it has to. The runner applies
-- every file in filename order, and `_migrations` makes that a no-op only for files
-- a given database has already seen. In an EXISTING database 9999 is recorded and
-- skipped, so a `0026_` name worked; in a FRESH one — every test run, CI, and any
-- new environment — 9999 runs after it and re-adds the very constraint this
-- replaces, and the whole suite dies on "constraint already exists". Amendments to
-- a guard must therefore outsort the guards file, hence the `A` prefix: '9' < 'A'.
--
-- `9999_guards.sql` carries the corrected definition too, so a fresh database is
-- right the moment it is built rather than briefly wrong and then patched.
--
-- `booking_slot_span_valid` read `slot_span >= 1 AND slot_idx + slot_span <= 4`.
-- The 4 is Kolkata's four-slot day, written into the database as though it were a
-- property of bookings. Two things follow from that, and both are wrong.
--
-- FIRST, it already breaks the other regions. The southern cities publish five slots
-- (`region.slots`), so an evening booking there is refused by Postgres even though
-- availability published it and `availability.service.ts` derived the bound from
-- `region.slots.length` — the application and the database disagreed, and the
-- database won.
--
-- SECOND, it caps how long a ritual can be. A full Chandi Paath or a Mahamrityunjay
-- jaap runs most of a day; at three hours a slot, a span of four fits only if it
-- starts at slot 0. Every other start is rejected. These are precisely the
-- large-ticket bookings worth taking, and the schema forbade them.
--
-- WHAT REPLACES IT. Nothing, for overlap — that guarantee moved to
-- `bookings_pandit_no_overlap` in migration 0018, a GiST exclusion constraint over
-- the real `tstzrange(slot_start_at, slot_end_at)`. It does not care how a day is
-- divided, which is the point: since ADR 0013 a booking IS an interval and
-- `slot_idx`/`slot_span` are bookkeeping for the slot-era views that have not
-- retired yet.
--
-- What stays is the part that was never city-specific: a span is at least one slot.
-- The upper bound is a sanity limit rather than a grid — no city publishes more than
-- eight slots, and a booking claiming more than a whole day is a bug, not a long
-- puja. Multi-day rituals are linked bookings (`parent_booking_id`), one row per
-- day, not one row with a span that runs off the end of the calendar.
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "booking_slot_span_valid";
--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "booking_slot_span_valid"
  CHECK ("slot_span" >= 1 AND "slot_span" <= 8);
--> statement-breakpoint

-- The same ceiling sat on the availability grid's own span check, for the same
-- reason and with the same consequence.
ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "booking_slot_idx_valid";
