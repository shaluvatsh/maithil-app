-- ---------------------------------------------------------------------------
-- COMMUNITY — C1 foundation. Spaces, Q&A posts, endorsements, reports, lexicon.
--
-- WHY THE GUARDS ARE IN THIS FILE and not in `9999_guards.sql`.
--
-- The runner applies every file in filename order and records it in `_migrations`,
-- so a file an existing database has already seen never runs again. `9999_guards.sql`
-- is recorded in every existing database; editing it would add these constraints to
-- a FRESH database and to nothing else, and the drift would be invisible until a
-- production write did something a test could not. `A0001_long_rituals.sql` carries
-- the long version of this lesson.
--
-- The `A` prefix exists for AMENDING a guard 9999 already defines. These constraints
-- are new and 9999 does not mention community at all, so there is nothing to amend
-- and nothing to collide with: the tables and the invariants that make them safe
-- ship together, in one transaction, and a database either has both or neither.
--
-- Nothing in booking, ledger or payments references anything created here. ADR 0014:
-- the community context must stay droppable, so a moderation incident can never
-- become a marketplace outage.
-- ---------------------------------------------------------------------------

-- 1. ENUMS -------------------------------------------------------------------

-- What people WRITE in, which is not what the app is TRANSLATED into. See the note
-- on `contentLocaleEnum` in schema/enums.ts. Must equal LANGUAGES in packages/region.
CREATE TYPE "content_locale" AS ENUM (
  'bn', 'hi', 'en', 'mai', 'ta', 'te', 'kn', 'ml', 'gu', 'or', 'mr');

CREATE TYPE "community_scope" AS ENUM ('city', 'state', 'national');
CREATE TYPE "community_space_kind" AS ENUM ('ritual', 'city', 'tradition', 'festival', 'general');
CREATE TYPE "community_posting_policy" AS ENUM ('open', 'verified_only', 'pandit_only');
CREATE TYPE "community_post_kind" AS ENUM ('question', 'answer', 'reply');
CREATE TYPE "community_post_state" AS ENUM ('published', 'held', 'removed');
CREATE TYPE "community_reaction_kind" AS ENUM ('pranam');
CREATE TYPE "community_trust_level" AS ENUM ('restricted', 'newcomer', 'member', 'contributor');
CREATE TYPE "community_report_reason" AS ENUM (
  'sectarian', 'caste', 'communal', 'political', 'medical_claim',
  'occult_solicitation', 'off_platform', 'spam', 'personal_info', 'other');
CREATE TYPE "community_report_state" AS ENUM ('open', 'acknowledged', 'actioned', 'rejected');

-- 2. TABLES ------------------------------------------------------------------

CREATE TABLE "community_spaces" (
  "id"             TEXT PRIMARY KEY,
  "slug"           TEXT NOT NULL UNIQUE,
  "kind"           "community_space_kind" NOT NULL,
  "scope"          "community_scope" NOT NULL,
  "city_id"        TEXT REFERENCES "cities"("id"),
  "state_name"     TEXT,
  "ritual_id"      TEXT REFERENCES "rituals"("id"),
  "tradition"      TEXT,
  "posting_policy" "community_posting_policy" NOT NULL DEFAULT 'open',
  "locales"        "content_locale"[] NOT NULL DEFAULT ARRAY[]::"content_locale"[],
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "community_profiles" (
  "user_id"               TEXT PRIMARY KEY REFERENCES "users"("id"),
  "display_name"          TEXT NOT NULL,
  "avatar_key"            TEXT,
  "bio"                   TEXT,
  "trust_level"           "community_trust_level" NOT NULL DEFAULT 'newcomer',
  "trust_reason"          TEXT NOT NULL DEFAULT 'signup',
  "trust_changed_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "question_count"        INTEGER NOT NULL DEFAULT 0,
  "answer_count"          INTEGER NOT NULL DEFAULT 0,
  "endorsements_received" INTEGER NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "community_posts" (
  "id"                 TEXT PRIMARY KEY,
  "space_id"           TEXT NOT NULL REFERENCES "community_spaces"("id"),
  "author_id"          TEXT NOT NULL REFERENCES "users"("id"),
  "kind"               "community_post_kind" NOT NULL,
  "parent_id"          TEXT REFERENCES "community_posts"("id"),
  "root_id"            TEXT REFERENCES "community_posts"("id"),
  "title"              TEXT,
  "body"               TEXT NOT NULL,
  "scope"              "community_scope" NOT NULL,
  "city_id"            TEXT REFERENCES "cities"("id"),
  "state_name"         TEXT,
  "locale"             "content_locale" NOT NULL,
  "panjika_school"     "panjika_school",
  "state"              "community_post_state" NOT NULL DEFAULT 'published',
  "held_at"            TIMESTAMPTZ,
  "held_reason"        TEXT,
  "removed_at"         TIMESTAMPTZ,
  "accepted_answer_id" TEXT REFERENCES "community_posts"("id"),
  "reply_count"        INTEGER NOT NULL DEFAULT 0,
  "pranam_count"       INTEGER NOT NULL DEFAULT 0,
  "endorsement_count"  INTEGER NOT NULL DEFAULT 0,
  "published_at"       TIMESTAMPTZ,
  "edited_at"          TIMESTAMPTZ,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "community_post_revisions" (
  "id"        TEXT PRIMARY KEY,
  "post_id"   TEXT NOT NULL REFERENCES "community_posts"("id"),
  "raw_body"  TEXT NOT NULL,
  "raw_title" TEXT,
  "editor_id" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "community_post_endorsements" (
  "post_id"    TEXT NOT NULL REFERENCES "community_posts"("id"),
  "pandit_id"  TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("post_id", "pandit_id")
);

CREATE TABLE "community_post_reactions" (
  "post_id"    TEXT NOT NULL REFERENCES "community_posts"("id"),
  "user_id"    TEXT NOT NULL REFERENCES "users"("id"),
  "kind"       "community_reaction_kind" NOT NULL DEFAULT 'pranam',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("post_id", "user_id", "kind")
);

CREATE TABLE "community_reports" (
  "id"              TEXT PRIMARY KEY,
  "post_id"         TEXT NOT NULL REFERENCES "community_posts"("id"),
  "reporter_id"     TEXT NOT NULL REFERENCES "users"("id"),
  "reason"          "community_report_reason" NOT NULL,
  "note"            TEXT,
  "state"           "community_report_state" NOT NULL DEFAULT 'open',
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "acknowledged_at" TIMESTAMPTZ,
  "resolved_at"     TIMESTAMPTZ,
  "resolved_by"     TEXT REFERENCES "users"("id"),
  "resolution"      TEXT
);

CREATE TABLE "community_moderation_terms" (
  "id"         TEXT PRIMARY KEY,
  "locale"     "content_locale",
  "term"       TEXT NOT NULL,
  "reason"     "community_report_reason" NOT NULL,
  "source"     TEXT NOT NULL,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "meta"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. INDEXES -----------------------------------------------------------------
-- The feed indexes are PARTIAL. A moderated forum accumulates held and removed rows
-- and they are never in a feed, so carrying them in the index every reader touches
-- is cost with no reader. Same for non-question kinds: a feed lists questions.

CREATE INDEX "community_spaces_scope_idx"
  ON "community_spaces" ("scope", "city_id", "active");

CREATE INDEX "community_posts_feed_idx"
  ON "community_posts" ("space_id", "published_at", "id")
  WHERE "state" = 'published' AND "kind" = 'question';

CREATE INDEX "community_posts_scope_feed_idx"
  ON "community_posts" ("scope", "city_id", "published_at", "id")
  WHERE "state" = 'published' AND "kind" = 'question';

CREATE INDEX "community_posts_thread_idx"
  ON "community_posts" ("root_id", "kind", "created_at");

CREATE INDEX "community_posts_author_idx"
  ON "community_posts" ("author_id", "created_at");

CREATE INDEX "community_posts_held_idx"
  ON "community_posts" ("held_at") WHERE "state" = 'held';

CREATE INDEX "community_post_revisions_post_idx"
  ON "community_post_revisions" ("post_id", "created_at");

CREATE INDEX "community_endorsements_pandit_idx"
  ON "community_post_endorsements" ("pandit_id", "created_at");

CREATE UNIQUE INDEX "community_reports_uniq"
  ON "community_reports" ("post_id", "reporter_id");

CREATE INDEX "community_reports_queue_idx"
  ON "community_reports" ("created_at") WHERE "state" = 'open';

CREATE UNIQUE INDEX "community_moderation_terms_uniq"
  ON "community_moderation_terms" ("locale", "term");

CREATE INDEX "community_moderation_terms_active_idx"
  ON "community_moderation_terms" ("active");

-- 4. GUARDS ------------------------------------------------------------------

-- LAW 1: scope is explicit, and the target column matches it.
--
-- A feed query that forgets its scope predicate returns a national firehose, and in
-- Kolkata-only dev data that is indistinguishable from correct. These CHECKs make
-- the row itself impossible to write ambiguously, so the failure happens at the
-- write in a test rather than at the read in Chennai.
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_scope_target" CHECK (
  (scope = 'city'     AND city_id IS NOT NULL AND state_name IS NULL) OR
  (scope = 'state'    AND state_name IS NOT NULL AND city_id IS NULL) OR
  (scope = 'national' AND city_id IS NULL AND state_name IS NULL));

ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_scope_target" CHECK (
  (scope = 'city'     AND city_id IS NOT NULL AND state_name IS NULL) OR
  (scope = 'state'    AND state_name IS NOT NULL AND city_id IS NULL) OR
  (scope = 'national' AND city_id IS NULL AND state_name IS NULL));

-- A published post has a publication instant, because that instant is the feed's
-- sort key and its cursor. A NULL here is a row that exists and can never be paged to.
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_published_has_instant"
  CHECK (state <> 'published' OR published_at IS NOT NULL);

-- Counters are non-negative. A negative count means a trigger double-fired, and it
-- should surface there rather than as a "-1 replies" label nobody can explain.
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_counts_non_negative"
  CHECK (reply_count >= 0 AND pranam_count >= 0 AND endorsement_count >= 0);

-- THE SHAPE: question -> answer -> reply, and no further.
--
-- Two levels, enforced here rather than in the service. Unbounded nesting is
-- unreadable on a phone in a script the reader may not be fluent in, and deep
-- threads are where flame wars live. This also pins the kind hierarchy, so a reply
-- can never hang off a question and skip the answer it was replying to.
CREATE OR REPLACE FUNCTION assert_post_shape() RETURNS trigger AS $$
DECLARE
  parent_kind "community_post_kind";
  parent_root TEXT;
BEGIN
  IF NEW.kind = 'question' THEN
    IF NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'a question has no parent' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.title IS NULL OR btrim(NEW.title) = '' THEN
      RAISE EXCEPTION 'a question needs a title' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.root_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'a question is its own root' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.title IS NOT NULL THEN
    RAISE EXCEPTION 'only a question carries a title' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_id IS NULL THEN
    RAISE EXCEPTION '% must have a parent', NEW.kind USING ERRCODE = 'check_violation';
  END IF;

  SELECT kind, root_id INTO parent_kind, parent_root
    FROM community_posts WHERE id = NEW.parent_id;

  IF parent_kind IS NULL THEN
    RAISE EXCEPTION 'parent post % does not exist', NEW.parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.kind = 'answer' AND parent_kind <> 'question' THEN
    RAISE EXCEPTION 'an answer must answer a question, not a %', parent_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'reply' AND parent_kind <> 'answer' THEN
    RAISE EXCEPTION 'a reply must reply to an answer, not a % — posts nest one level only',
      parent_kind USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.root_id IS DISTINCT FROM parent_root THEN
    RAISE EXCEPTION 'root_id must match the parent thread' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_posts_shape
  BEFORE INSERT OR UPDATE OF kind, parent_id, root_id, title ON "community_posts"
  FOR EACH ROW EXECUTE FUNCTION assert_post_shape();

-- An accepted answer must be an answer TO THAT question. Without this it is a
-- foreign key to any row in the table, which is to say no constraint at all.
CREATE OR REPLACE FUNCTION assert_accepted_answer() RETURNS trigger AS $$
BEGIN
  IF NEW.accepted_answer_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.kind <> 'question' THEN
    RAISE EXCEPTION 'only a question accepts an answer' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM community_posts a
     WHERE a.id = NEW.accepted_answer_id AND a.kind = 'answer' AND a.parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'accepted answer % is not an answer to question %',
      NEW.accepted_answer_id, NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_posts_accepted_answer
  BEFORE INSERT OR UPDATE OF accepted_answer_id ON "community_posts"
  FOR EACH ROW EXECUTE FUNCTION assert_accepted_answer();

-- ONLY A VERIFIED PUROHIT MAY ENDORSE, and only an answer.
--
-- This is the signal the entire surface rests on: verified answers outrank everything
-- and peer endorsement orders them. In application code one missing import bypasses
-- it; here nothing does, including a psql session and a future admin tool.
CREATE OR REPLACE FUNCTION assert_endorser_verified() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pandit_profiles p
     WHERE p.user_id = NEW.pandit_id AND p.kyc_status = 'verified'
  ) THEN
    RAISE EXCEPTION 'only a verified purohit may endorse an answer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM community_posts c
     WHERE c.id = NEW.post_id AND c.kind = 'answer'
  ) THEN
    RAISE EXCEPTION 'only an answer can be endorsed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM community_posts c
     WHERE c.id = NEW.post_id AND c.author_id = NEW.pandit_id
  ) THEN
    RAISE EXCEPTION 'a purohit cannot endorse their own answer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_endorsements_verified
  BEFORE INSERT ON "community_post_endorsements"
  FOR EACH ROW EXECUTE FUNCTION assert_endorser_verified();

-- COUNTERS. Maintained here so a feed of twenty rows is one query (Law 3).
--
-- Counting at read time is N+1 wearing a disguise, and it is the single most common
-- way a feed that was fast with a hundred rows stops being fast with a hundred
-- thousand. The CHECK above catches a double-fire; this keeps the numbers true.
CREATE OR REPLACE FUNCTION community_bump_reply_count() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_id IS NOT NULL THEN
    UPDATE community_posts SET reply_count = reply_count + 1 WHERE id = NEW.parent_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_id IS NOT NULL THEN
    UPDATE community_posts SET reply_count = reply_count - 1 WHERE id = OLD.parent_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_posts_reply_count
  AFTER INSERT OR DELETE ON "community_posts"
  FOR EACH ROW EXECUTE FUNCTION community_bump_reply_count();

CREATE OR REPLACE FUNCTION community_bump_pranam_count() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE community_posts SET pranam_count = pranam_count + 1 WHERE id = NEW.post_id;
  ELSE
    UPDATE community_posts SET pranam_count = pranam_count - 1 WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_reactions_count
  AFTER INSERT OR DELETE ON "community_post_reactions"
  FOR EACH ROW EXECUTE FUNCTION community_bump_pranam_count();

CREATE OR REPLACE FUNCTION community_bump_endorsement_count() RETURNS trigger AS $$
DECLARE
  author TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE community_posts SET endorsement_count = endorsement_count + 1
     WHERE id = NEW.post_id RETURNING author_id INTO author;
    UPDATE community_profiles SET endorsements_received = endorsements_received + 1
     WHERE user_id = author;
  ELSE
    UPDATE community_posts SET endorsement_count = endorsement_count - 1
     WHERE id = OLD.post_id RETURNING author_id INTO author;
    UPDATE community_profiles SET endorsements_received = endorsements_received - 1
     WHERE user_id = author;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_endorsements_count
  AFTER INSERT OR DELETE ON "community_post_endorsements"
  FOR EACH ROW EXECUTE FUNCTION community_bump_endorsement_count();

CREATE OR REPLACE FUNCTION community_bump_profile_counts() RETURNS trigger AS $$
BEGIN
  -- A profile may legitimately not exist yet; the UPDATE is then a no-op rather
  -- than an error, because a missing counter must never block a post.
  IF NEW.kind = 'question' THEN
    UPDATE community_profiles SET question_count = question_count + 1
     WHERE user_id = NEW.author_id;
  ELSIF NEW.kind = 'answer' THEN
    UPDATE community_profiles SET answer_count = answer_count + 1
     WHERE user_id = NEW.author_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_posts_profile_counts
  AFTER INSERT ON "community_posts"
  FOR EACH ROW EXECUTE FUNCTION community_bump_profile_counts();

-- Revisions are append-only, like the ledger and like booking_events.
--
-- An edited answer that changed a ritual instruction must stay reconstructible: a
-- devotee may already have acted on the previous wording. This table also holds the
-- UNSCRUBBED body, which is the only record of a contact detail someone tried to
-- post, so an edit that rewrote history would erase the evidence of the leak too.
CREATE OR REPLACE FUNCTION reject_revision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'community_post_revisions is append-only; write a new revision'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_revisions_append_only
  BEFORE UPDATE OR DELETE ON "community_post_revisions"
  FOR EACH ROW EXECUTE FUNCTION reject_revision_mutation();
