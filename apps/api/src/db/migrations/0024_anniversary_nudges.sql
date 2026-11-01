-- The anniversary reminder's dedup record.
--
-- `GET /v1/me/anniversaries` has computed "you did this last year and it is coming
-- round again" since it was written, and nothing ever sent it. `AnniversaryJob` is
-- the sender; this table is what stops it sending twice.
--
-- The PRIMARY KEY is the deduplication, deliberately, rather than a `SELECT ... IF
-- NOT EXISTS` in the job: the job claims a row before it calls the BSP, so a crash
-- or a redeploy mid-batch leaves a claimed-but-unsent nudge (a message nobody gets)
-- instead of an unclaimed-but-sent one (a message somebody gets twice). For an
-- unsolicited reminder that is the right way to fail.
--
-- `ritual_id` carries no foreign key on purpose. The reminder is a record of
-- something we SENT, and it must survive a ritual being retired from the catalogue
-- -- an ON DELETE CASCADE here would silently make a household eligible to be
-- nudged again for a puja we no longer offer. `devotee_id` does cascade, because a
-- deleted account should leave nothing behind.
CREATE TABLE IF NOT EXISTS "anniversary_nudges" (
  "devotee_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "ritual_id"  text NOT NULL,
  "year"       integer NOT NULL,
  "sent_at"    timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("devotee_id", "ritual_id", "year")
);
