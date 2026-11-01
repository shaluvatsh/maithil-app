-- How a REMOTE booking is actually delivered.
--
-- The catalogue has sold two virtual rituals since it was seeded — `online-aarti`
-- ("Live aarti by video, joined from anywhere", ₹499) and `virtual-consultation`
-- (₹1,100) — both carrying `delivery_mode = 'virtual'`. There was no video anywhere
-- in the system: no meeting link, no join URL, no recording, on the booking row or
-- any other. A devotee could pay for a live video aarti and neither they nor the
-- purohit was given any way to reach the other.
--
-- Two columns, because they answer two different questions at two different times.
--
-- `join_url` is BEFORE. The purohit puts their own meeting link here (they already
-- have one — this persona runs pujas on WhatsApp video and Meet today), and the
-- devotee sees it on their booking. Deliberately not a link we generate: standing
-- up video infrastructure to sell a ₹499 aarti is the wrong order of work, and a
-- purohit's existing room is one they can already operate.
--
-- `recording_url` is AFTER, and it is the one that matters commercially. For a
-- ritual nobody attended in person the recording IS the proof of performance —
-- it is what the devotee keeps, what an NRI booking for their parents actually
-- bought, and, per the founding blueprint's own risk table, what prevents a
-- chargeback. Nullable because it is optional on a consultation and expected on an
-- aarti; the product asks rather than enforcing.
--
-- Both are plain text URLs rather than object keys: these point at the purohit's
-- meeting provider, not at our bucket. A recording they choose to upload to us
-- instead goes through the existing presigned path and lands here as the signed
-- URL's key — which is why there is no CHECK on the shape.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "join_url" text;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "recording_url" text;
--> statement-breakpoint

-- The sankalp, recorded by the PUROHIT on arrival rather than asked at checkout.
--
-- `sankalp jsonb` has been on the row since the beginning and the contract's own
-- comment explains why it was pulled out of the payment screen: it was "two personal
-- questions, one of them a gotra many urban families are not certain of, asked at the
-- most abandonable moment in the flow, in exchange for nothing" — nothing ever read
-- it back. The same comment names the fix: "the natural home for this is the purohit
-- recording it when they arrive."
--
-- No schema change is needed for the value itself; this index is. The point of
-- capturing it is that NEXT year's booking already knows the family's gotra, which
-- means looking up a devotee's most recent booking that has one — a query that would
-- otherwise scan every booking they have ever made.
CREATE INDEX IF NOT EXISTS "bookings_devotee_sankalp_idx"
  ON "bookings" ("devotee_id", "created_at" DESC)
  WHERE "sankalp" IS NOT NULL;
