-- ---------------------------------------------------------------------------
-- Match decisions — the observability ADR 0012 asked for and never got.
--
-- That ADR closed with: "Matching is now load-bearing… A bug in the weights is a bug
-- in someone's livelihood. The weights need to be observable — log the chosen purohit
-- and the runner-up per booking." Nothing did, so every allocation since has been
-- unreconstructable: we cannot tell whether the load penalty is actually spreading
-- work, and a purohit whose income halved cannot be told why.
--
-- This is also the prerequisite for the purohit dashboard. "You were offered 14 and
-- took 13; four more were near you and went to someone else" is derivable from these
-- rows and from nothing else.
--
-- Written best-effort from `matchPandit`: a failure to record must never fail an
-- allocation.
-- ---------------------------------------------------------------------------

CREATE TABLE "match_decisions" (
  "id"               TEXT PRIMARY KEY,
  "booking_id"       TEXT NOT NULL REFERENCES "bookings"("id"),
  "ritual_id"        TEXT NOT NULL,
  -- Null when nobody was available. That is a fact worth counting, not a missing row.
  "chosen_pandit_id" TEXT REFERENCES "users"("id"),
  "chosen_score"     TEXT,
  -- Snapshotted, because an allocation explained with later weights is explained wrong.
  "weights"          JSONB NOT NULL,
  "candidates"       JSONB NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "match_decisions_booking_idx" ON "match_decisions" ("booking_id");
-- The purohit-facing query: what was I allocated, newest first.
CREATE INDEX "match_decisions_chosen_idx"
  ON "match_decisions" ("chosen_pandit_id", "created_at");

-- One decision per booking. A re-match after a decline is a NEW decision for the same
-- booking, so this is deliberately not unique on booking_id — but a decision with no
-- candidates at all is a bug, not an empty roster, and this catches it.
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_has_candidates"
  CHECK (jsonb_typeof("candidates") = 'array');
