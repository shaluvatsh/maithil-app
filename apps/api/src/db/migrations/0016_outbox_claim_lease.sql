-- The relay used to hold one Postgres transaction (and its pooled connection) open
-- across an entire batch's publish calls, so that a claimed row's lock would block a
-- second relay instance from claiming it too. That made the row lock double as the
-- concurrency guard, but it meant up to 100 sequential, awaited external HTTP calls
-- (the WhatsApp send) ran while holding one of only ten pooled connections shared
-- with every other request the API serves - a slow BSP response stalled that
-- connection, and everything else competing for the pool, for as long as the batch
-- took.
--
-- `claimed_at` turns the claim into a lease: a single fast UPDATE marks a batch
-- claimed and commits immediately, releasing the connection before a single publish()
-- call runs. A second instance skips a freshly-claimed row without waiting on a lock;
-- a row whose claimant crashed mid-batch becomes reclaimable once the lease is older
-- than the relay's visibility timeout, rather than being held forever by a lock
-- nobody will ever release.
ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "outbox_unpublished";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_unpublished" ON "outbox" ("published_at", "claimed_at", "id");
