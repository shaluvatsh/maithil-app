-- Session revocation.
--
-- Refresh tokens live 30 days and carried nothing that could invalidate them, so
-- there was no way to end a session early: changing a password left every stolen
-- token working for a month, and "sign out everywhere" could not be built at all.
-- For a product whose primary sign-in is now email and password, that is the wrong
-- shape — a password change is the exact action someone takes when they believe an
-- account is compromised, and it did nothing to the sessions already open.
--
-- A counter rather than a table of revoked ids: revocation here is always "end every
-- session for this account", never "end this one device". A per-token denylist would
-- cost a row per sign-out and a lookup per request to express something nobody has
-- asked for. Bumping an integer invalidates every token issued before it, and the
-- check costs nothing extra because `refresh()` already loads the user row.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0;
