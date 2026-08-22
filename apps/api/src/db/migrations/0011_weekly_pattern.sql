-- A purohit's usual working week.
--
-- Availability is stored per (date, slot), which is right: a booking locks a row and
-- a specific afternoon has to be closeable on its own. But it is a terrible way to
-- DECLARE availability. "I work Tuesday and Thursday mornings" is one sentence, and
-- saying it through the per-date model meant tapping four slots across thirty days —
-- 120 decisions to express one.
--
-- This is the shift-booking pattern every gig platform settled on for the same
-- reason: the worker states a repeating shape once, the system projects it forward,
-- and individual days are overridden by exception. The per-date rows remain the
-- source of truth for what is bookable; this is the rule that generates them.
--
-- Deliberately NOT a replacement for the per-date rows. A pattern cannot know that
-- a slot is already booked, and regenerating from it would release confirmed pujas.

CREATE TABLE IF NOT EXISTS pandit_weekly_patterns (
  pandit_id   TEXT NOT NULL REFERENCES pandit_profiles(user_id) ON DELETE CASCADE,
  -- 0 = Sunday, matching JS getDay() and Postgres EXTRACT(DOW).
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot_idx    INTEGER NOT NULL CHECK (slot_idx >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pandit_id, weekday, slot_idx)
);

-- The whole pattern is read at once, per purohit, whenever it is applied.
CREATE INDEX IF NOT EXISTS pandit_weekly_patterns_pandit_idx
  ON pandit_weekly_patterns (pandit_id);
