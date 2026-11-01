-- An index for the overlap check the READ path actually makes.
--
-- `bookings_pandit_no_overlap` (migration 0018) is an EXCLUSION CONSTRAINT, and its
-- predicate is correctly the integrity rule it enforces: a purohit may not hold two
-- `confirmed`/`in_progress` bookings over the same instants. That is the right scope
-- for a constraint and must not be widened — a `pending_accept` booking is an unpaid
-- hold, and refusing a second one outright would make an abandoned checkout block the
-- slot for everyone until it expired.
--
-- But two hot reads ask a WIDER question. `BookableTimesService.forDate` and
-- `SearchService.rankPandits` both test:
--
--   b.state IN ('pending_accept','confirmed','in_progress','completed')
--   AND tstzrange(b.slot_start_at, b.slot_end_at) && tstzrange(<window>)
--
-- Those two extra states put the query outside the constraint's `WHERE`, so Postgres
-- cannot use the GiST index for them at all. Measured on this schema with
-- `enable_seqscan=off`, the two predicates plan differently:
--
--   4 states → Index Scan using bookings_pandit_idx
--              Index Cond: (pandit_id = $1 AND state = ANY (...))
--              Filter:     tstzrange(slot_start_at, slot_end_at) && tstzrange(...)
--
--   2 states → Index Scan using bookings_pandit_no_overlap
--              Index Cond: (pandit_id = $1 AND tstzrange(...) && tstzrange(...))
--
-- In the first the RANGE IS A FILTER, not a seek: every booking that purohit has ever
-- held in those four states is fetched and discarded in the executor. `completed` is
-- the state that makes this bite, because it is the one that only ever grows — the
-- same fault, in the same table, that `me/jobs` was fixed for, where the comment reads
-- "a purohit two years in with a thousand finished pujas paid for all thousand rows".
--
-- And this one is paid far more often than that inbox: `forDate` evaluates 48 windows
-- against every candidate purohit, on the screen a devotee is actively waiting on,
-- for every date they tap.
--
-- So: a second GiST index whose predicate matches the reads. The constraint keeps its
-- own narrow predicate and its own job.
CREATE INDEX IF NOT EXISTS "bookings_pandit_window_idx"
  ON "bookings" USING gist (
    "pandit_id",
    tstzrange("slot_start_at", "slot_end_at")
  ) WHERE ("state" IN ('pending_accept', 'confirmed', 'in_progress', 'completed'));
