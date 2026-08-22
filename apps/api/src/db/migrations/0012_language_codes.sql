-- Language display names -> locale codes.
--
-- `pandit_profiles.languages` has held two encodings since the onboarding wizard was
-- written. `db:seed:dev` writes locale codes (`{bn,hi}`); the wizard wrote English
-- display names (`{Bengali}`). Devotee search matches with an array overlap
-- (`pp.languages && ARRAY[...]`), so a filter for `bn` matched every seeded purohit
-- and no self-registered one. Nothing errored — the two halves of the supply were
-- simply never comparable.
--
-- The API now refuses anything that is not a known code, so this is the one-time
-- repair of rows written before that. Idempotent, and it leaves anything it does not
-- recognise alone rather than guessing: an unmapped value is a question for an
-- operator, not something to silently drop from a purohit's profile.
UPDATE pandit_profiles
SET languages = (
  SELECT array_agg(
    CASE lower(l)
      WHEN 'bengali'   THEN 'bn'
      WHEN 'bangla'    THEN 'bn'
      WHEN 'hindi'     THEN 'hi'
      WHEN 'english'   THEN 'en'
      WHEN 'maithili'  THEN 'mai'
      WHEN 'tamil'     THEN 'ta'
      WHEN 'telugu'    THEN 'te'
      WHEN 'kannada'   THEN 'kn'
      WHEN 'malayalam' THEN 'ml'
      WHEN 'gujarati'  THEN 'gu'
      WHEN 'odia'      THEN 'or'
      WHEN 'oriya'     THEN 'or'
      WHEN 'marathi'   THEN 'mr'
      ELSE l
    END
    ORDER BY l
  )
  FROM unnest(languages) AS l
)
WHERE EXISTS (
  SELECT 1 FROM unnest(languages) AS l
  WHERE lower(l) IN (
    'bengali','bangla','hindi','english','maithili','tamil','telugu',
    'kannada','malayalam','gujarati','odia','oriya','marathi'
  )
);
