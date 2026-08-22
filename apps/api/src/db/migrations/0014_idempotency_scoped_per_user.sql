-- Idempotency keys were unique across ALL users on `key` alone, so two different
-- users who happened to submit the same client-generated key collided: one read
-- back the other's cached response, or was told a request was "already in
-- progress" for a request they never made. Scoping the primary key to
-- (user_id, key) makes the uniqueness match what the client actually controls.
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_pkey";
ALTER TABLE "idempotency_keys" ADD PRIMARY KEY ("user_id", "key");
