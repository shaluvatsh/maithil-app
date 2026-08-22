-- Remote services.
--
-- Online Aarti and Virtual Consultation are performed over video: the purohit does not
-- travel, brings no samagri, and needs no address. Everything else about a booking is
-- identical, so this is one column rather than a second booking path.
--
-- TEXT with a CHECK rather than an enum: `panjika_school` is already an enum and
-- UI-ARCHITECTURE.md flags enums as a liability past a handful of values, because
-- ALTER TYPE can add but never remove or reorder.

ALTER TABLE rituals
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'at_home';
--> statement-breakpoint

ALTER TABLE rituals
  DROP CONSTRAINT IF EXISTS rituals_delivery_mode_check;
--> statement-breakpoint

ALTER TABLE rituals
  ADD CONSTRAINT rituals_delivery_mode_check
  CHECK (delivery_mode IN ('at_home', 'virtual'));
--> statement-breakpoint

-- Browse filters by category and orders by sort_order; delivery_mode joins that
-- predicate on the online tab.
CREATE INDEX IF NOT EXISTS rituals_delivery_mode_idx
  ON rituals (delivery_mode)
  WHERE active;
