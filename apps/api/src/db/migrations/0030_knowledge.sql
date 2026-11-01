-- ---------------------------------------------------------------------------
-- The knowledge library (C3).
--
-- Not `community_posts` with a type column. A forum post is conversational, written
-- once, in one language; a knowledge item is curated, translated, cited, reviewed
-- before publication and indexed by search engines. Structurally it is
-- `rituals` + `ritual_translations`. Merging them grows an editorial workflow onto
-- the table that also serves a feed, and the feed wins every conflict.
--
-- THE REVIEW GATE IS THE PRODUCT, so it is a trigger rather than a service rule.
-- Nothing publishes without a verified purohit or an operator signing off, and the
-- reviewer may not be the author. Every other app in this category is a firehose of
-- unsourced text; "somebody qualified read this and put their name to it" is the only
-- durable differentiator available, and it costs nothing but enforcing it here.
-- ---------------------------------------------------------------------------

CREATE TYPE "knowledge_type" AS ENUM (
  'article', 'ritual_guide', 'mantra_audio', 'video', 'shloka', 'glossary');
CREATE TYPE "knowledge_level" AS ENUM ('beginner', 'deep');
CREATE TYPE "knowledge_status" AS ENUM ('draft', 'in_review', 'published', 'retired');

CREATE TABLE "knowledge_items" (
  "id"             TEXT PRIMARY KEY,
  "slug"           TEXT NOT NULL UNIQUE,
  "author_id"      TEXT NOT NULL REFERENCES "users"("id"),
  "type"           "knowledge_type" NOT NULL,
  "level"          "knowledge_level" NOT NULL DEFAULT 'beginner',
  "ritual_id"      TEXT REFERENCES "rituals"("id"),
  "tradition"      TEXT,
  "primary_locale" "content_locale" NOT NULL,
  "status"         "knowledge_status" NOT NULL DEFAULT 'draft',
  "reviewed_by"    TEXT REFERENCES "users"("id"),
  "reviewed_at"    TIMESTAMPTZ,
  "review_note"    TEXT,
  "cover_key"      TEXT,
  "media_key"      TEXT,
  "duration_sec"   INTEGER,
  "published_at"   TIMESTAMPTZ,
  "retired_at"     TIMESTAMPTZ,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "knowledge_translations" (
  "item_id"       TEXT NOT NULL REFERENCES "knowledge_items"("id"),
  "locale"        "content_locale" NOT NULL,
  "title"         TEXT NOT NULL,
  "summary"       TEXT NOT NULL,
  "body"          TEXT NOT NULL,
  "transcript"    TEXT,
  "translated_by" TEXT REFERENCES "users"("id"),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("item_id", "locale")
);

CREATE TABLE "knowledge_citations" (
  "id"         TEXT PRIMARY KEY,
  "item_id"    TEXT NOT NULL REFERENCES "knowledge_items"("id"),
  "work"       TEXT NOT NULL,
  "chapter"    TEXT,
  "verse"      TEXT,
  "note"       TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INDEXES -------------------------------------------------------------------

-- The library's hot path. Partial on published: drafts and retired items are never
-- in a listing, and carrying them in the index every reader touches is pure cost.
CREATE INDEX "knowledge_browse_idx"
  ON "knowledge_items" ("type", "published_at" DESC)
  WHERE "status" = 'published';

-- A ritual page asking "what explains this".
CREATE INDEX "knowledge_ritual_idx"
  ON "knowledge_items" ("ritual_id") WHERE "status" = 'published';

-- The review queue, oldest wait first — the same SLA ordering moderation uses.
CREATE INDEX "knowledge_queue_idx"
  ON "knowledge_items" ("updated_at") WHERE "status" = 'in_review';

CREATE INDEX "knowledge_author_idx" ON "knowledge_items" ("author_id", "created_at");
CREATE INDEX "knowledge_citations_item_idx" ON "knowledge_citations" ("item_id");

-- One citation per passage per item. COALESCE because a citation with no chapter is
-- still one citation, and NULLs would otherwise never collide.
CREATE UNIQUE INDEX "knowledge_citations_uniq"
  ON "knowledge_citations" ("item_id", "work",
                            COALESCE("chapter", ''), COALESCE("verse", ''));

-- GUARDS --------------------------------------------------------------------

-- A published item has a publication instant, because that is the browse sort key.
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_published_has_instant"
  CHECK ("status" <> 'published' OR "published_at" IS NOT NULL);

-- Media types carry media. A `mantra_audio` with no recording is a title.
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_media_present"
  CHECK ("status" <> 'published'
         OR "type" NOT IN ('mantra_audio', 'video')
         OR "media_key" IS NOT NULL);

ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_duration_sane"
  CHECK ("duration_sec" IS NULL OR "duration_sec" > 0);

/*
 * THE REVIEW GATE.
 *
 * Three rules, and the third is the one that matters:
 *
 *   1. A published item has a reviewer.
 *   2. The reviewer is a verified purohit or an operator.
 *   3. The reviewer is NOT the author.
 *
 * Rule 3 means a verified purohit's own article is peer-reviewed, which is the same
 * discipline `assert_endorser_verified` applies on the Q&A board — nobody vouches for
 * themselves. Operators can always review, so this is a quality bar rather than a
 * bottleneck.
 *
 * A published item must also HAVE text. An item with no translation row is a slug
 * and a status, and it would render as an empty page with a working URL — which is
 * worse than a 404 because a crawler will index it.
 */
CREATE OR REPLACE FUNCTION assert_knowledge_reviewer() RETURNS trigger AS $$
DECLARE
  reviewer_role TEXT;
  reviewer_kyc  TEXT;
  n_translations INT;
BEGIN
  IF NEW.status <> 'published' THEN RETURN NEW; END IF;

  IF NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'nothing publishes here without a reviewer'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reviewed_by = NEW.author_id THEN
    RAISE EXCEPTION 'the reviewer cannot be the author'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT u.role, pp.kyc_status INTO reviewer_role, reviewer_kyc
    FROM users u
    LEFT JOIN pandit_profiles pp ON pp.user_id = u.id
   WHERE u.id = NEW.reviewed_by;

  IF reviewer_role IS NULL THEN
    RAISE EXCEPTION 'reviewer % does not exist', NEW.reviewed_by
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF reviewer_role NOT IN ('admin', 'ops')
     AND (reviewer_role <> 'pandit' OR reviewer_kyc IS DISTINCT FROM 'verified') THEN
    RAISE EXCEPTION 'only a verified purohit or an operator may publish knowledge'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO n_translations
    FROM knowledge_translations WHERE item_id = NEW.id;
  IF n_translations = 0 THEN
    RAISE EXCEPTION 'a published item needs text in at least one language'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_items_reviewer
  BEFORE INSERT OR UPDATE OF status, reviewed_by, author_id ON "knowledge_items"
  FOR EACH ROW EXECUTE FUNCTION assert_knowledge_reviewer();

/*
 * A translation cannot be removed from under a published item.
 *
 * Deleting the last one would leave a live URL with no text — and because the check
 * above only fires on the item, nothing else would notice. The guard belongs on the
 * table that can break the invariant.
 */
CREATE OR REPLACE FUNCTION assert_translation_remains() RETURNS trigger AS $$
DECLARE
  item_status "knowledge_status";
  remaining INT;
BEGIN
  SELECT status INTO item_status FROM knowledge_items WHERE id = OLD.item_id;
  IF item_status <> 'published' THEN RETURN OLD; END IF;

  SELECT count(*) INTO remaining
    FROM knowledge_translations
   WHERE item_id = OLD.item_id AND locale <> OLD.locale;
  IF remaining = 0 THEN
    RAISE EXCEPTION 'a published item must keep text in at least one language'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_translations_keep_one
  BEFORE DELETE ON "knowledge_translations"
  FOR EACH ROW EXECUTE FUNCTION assert_translation_remains();
