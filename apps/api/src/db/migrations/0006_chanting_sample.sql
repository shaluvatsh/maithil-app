-- A 30-second recording of the purohit chanting.
--
-- Devotees care enormously about shuddha uchcharan, and no listing site in the
-- category lets you hear it. It is the cheapest high-trust signal available and it
-- cannot be faked by a marketing team — either the purohit can chant or they cannot.
--
-- URL rather than a blob: the audio lives in object storage, and Postgres holds the
-- reference. `chanting_sample_label` names what is being recited, because "listen to
-- a clip" is far weaker than "hear him recite Ganapati Atharvashirsha".

ALTER TABLE pandit_profiles
  ADD COLUMN IF NOT EXISTS chanting_sample_url TEXT;
--> statement-breakpoint

ALTER TABLE pandit_profiles
  ADD COLUMN IF NOT EXISTS chanting_sample_label TEXT;
--> statement-breakpoint

ALTER TABLE pandit_profiles
  DROP CONSTRAINT IF EXISTS pandit_chanting_url_check;
--> statement-breakpoint

-- Only https. An http URL would be blocked as mixed content on every modern
-- browser, so accepting one just produces a player that silently never plays.
ALTER TABLE pandit_profiles
  ADD CONSTRAINT pandit_chanting_url_check
  CHECK (chanting_sample_url IS NULL OR chanting_sample_url LIKE 'https://%');
