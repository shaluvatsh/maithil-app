-- Email + password as a second sign-in method alongside phone OTP.
--
-- Phone stays the identity spine (it is how a purohit is reached and how OTPs are
-- delivered), so `phone` remains NOT NULL UNIQUE. Email is optional and unique when
-- present, which is why this is a partial unique index rather than a column
-- constraint - several accounts can legitimately have no email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq
  ON users (lower(email)) WHERE email IS NOT NULL;
