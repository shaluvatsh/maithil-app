-- `users.phone` was unique; `users.email` was not, even though `loginWithPassword`
-- looks an account up by email alone and takes the first row. Registration's
-- "does this email already exist" check was a plain SELECT before an INSERT, with
-- nothing in the database to enforce the answer, so two concurrent registrations
-- for the same new email both passed the check and both inserted. The result was
-- two accounts sharing one email, with password login arbitrarily picking one of
-- them - the other owner silently locked out of their own bookings.
--
-- Case-insensitive, because that is how the lookup queries it
-- (`lower(email) = $1`); a unique index on the raw column would still have let
-- `Someone@example.com` and `someone@example.com` coexist and defeat the point.
--
-- Partial, because email is optional: every OTP-only account has NULL here, and
-- NULLs are distinct in a plain unique index but there is no reason to index them.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uniq"
  ON "users" (lower("email"))
  WHERE "email" IS NOT NULL;
