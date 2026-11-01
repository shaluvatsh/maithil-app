-- ---------------------------------------------------------------------------
-- EVENTS (C2). Their own tables and their own state machine. ADR 0015.
--
-- Not `bookings` with a flag. A booking is one devotee, one purohit, one home
-- address, escrow, an OTP handshake at the door, travel buffers and TDS; an event is
-- many devotees, one host, a public venue, and none of those. Reusing the booking
-- state machine would put `cancelled_pandit` and `offline_capture_at` on a temple
-- kirtan and weaken the one state machine in this product that carries money.
--
-- Reused instead: the ledger (entry types added below), payment intents, the outbox,
-- `pincode_centroids`, the Redis hold pattern and the OTP-hash check-in pattern.
--
-- CAPACITY IS THIS CONTEXT'S LEDGER INVARIANT. `seats_taken` is the truth,
-- `seats_within_capacity` is the seatbelt, and the registration transaction takes
-- `SELECT … FOR UPDATE` on the session row. Counting registration rows and comparing
-- is a race that oversells under festival load; a CHECK fails loudly instead.
-- ---------------------------------------------------------------------------

-- 1. ENUMS -------------------------------------------------------------------

CREATE TYPE "event_host_kind" AS ENUM ('pandit', 'devotee', 'org', 'platform');
CREATE TYPE "event_kind" AS ENUM (
  'puja', 'kirtan', 'katha', 'paath', 'festival', 'class', 'yatra', 'seva');
CREATE TYPE "event_registration_mode" AS ENUM ('none', 'rsvp', 'ticketed', 'seva_slots');
CREATE TYPE "event_state" AS ENUM (
  'draft', 'pending_review', 'published', 'cancelled', 'completed');
CREATE TYPE "event_registration_state" AS ENUM (
  'held', 'confirmed', 'waitlisted', 'cancelled', 'attended', 'no_show');

-- Ticketed events, declared with the tables so the two ship together. Unreachable
-- until the money path is wired: `publishEvent` refuses a ticketed event outright,
-- rather than letting a half-built payment flow take a rupee.
ALTER TYPE "ledger_entry_type" ADD VALUE IF NOT EXISTS 'event_ticket';
ALTER TYPE "ledger_entry_type" ADD VALUE IF NOT EXISTS 'event_refund';
ALTER TYPE "ledger_entry_type" ADD VALUE IF NOT EXISTS 'event_commission';

-- 2. TABLES ------------------------------------------------------------------

CREATE TABLE "events" (
  "id"                TEXT PRIMARY KEY,
  "host_id"           TEXT NOT NULL REFERENCES "users"("id"),
  "host_kind"         "event_host_kind" NOT NULL,
  "kind"              "event_kind" NOT NULL,
  "ritual_id"         TEXT REFERENCES "rituals"("id"),
  "title"             TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "locale"            "content_locale" NOT NULL,
  "city_id"           TEXT NOT NULL REFERENCES "cities"("id"),
  "venue_name"        TEXT NOT NULL,
  "venue_line1"       TEXT NOT NULL,
  "pincode"           TEXT,
  "lat"               DOUBLE PRECISION NOT NULL,
  "lng"               DOUBLE PRECISION NOT NULL,
  "geo_precision"     "geo_precision" NOT NULL DEFAULT 'city',
  "start_at"          TIMESTAMPTZ NOT NULL,
  "end_at"            TIMESTAMPTZ NOT NULL,
  "panjika_school"    "panjika_school",
  "registration_mode" "event_registration_mode" NOT NULL DEFAULT 'none',
  "state"             "event_state" NOT NULL DEFAULT 'draft',
  "verified_by"       TEXT REFERENCES "users"("id"),
  "cover_key"         TEXT,
  "external_url"      TEXT,
  "cancelled_at"      TIMESTAMPTZ,
  "cancel_reason"     TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "event_sessions" (
  "id"           TEXT PRIMARY KEY,
  "event_id"     TEXT NOT NULL REFERENCES "events"("id"),
  "start_at"     TIMESTAMPTZ NOT NULL,
  "end_at"       TIMESTAMPTZ NOT NULL,
  "capacity"     INTEGER,
  /*
   * How far past `capacity` this session may be confirmed, in basis points.
   *
   * STORED, not read from configuration at write time, because the CHECK below has
   * to be able to evaluate the ceiling — and because changing an environment
   * variable must not retroactively move the ceiling of a session people have
   * already registered for. `COMMUNITY_FREE_EVENT_OVERBOOK_BPS` is the default a
   * new free session is created with; 10000 (no overbooking) is the default here,
   * so a row written by anything that does not know about the knob is safe.
   */
  "oversell_bps" INTEGER NOT NULL DEFAULT 10000,
  "seats_taken"  INTEGER NOT NULL DEFAULT 0,
  "price_paise"  BIGINT NOT NULL DEFAULT 0,
  "cancelled_at" TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "event_registrations" (
  "id"                TEXT PRIMARY KEY,
  "session_id"        TEXT NOT NULL REFERENCES "event_sessions"("id"),
  "user_id"           TEXT NOT NULL REFERENCES "users"("id"),
  "seats"             INTEGER NOT NULL DEFAULT 1,
  "state"             "event_registration_state" NOT NULL DEFAULT 'confirmed',
  "hold_expires_at"   TIMESTAMPTZ,
  "checkin_code_hash" TEXT,
  "checked_in_at"     TIMESTAMPTZ,
  "payment_intent_id" TEXT,
  "cancelled_at"      TIMESTAMPTZ,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. INDEXES -----------------------------------------------------------------

CREATE INDEX "events_discovery_idx" ON "events" ("city_id", "state", "start_at");
-- The bounding-box prefilter. A btree cannot serve a radius query, but it serves the
-- box that brackets one; haversine then orders inside the box and trims the corners.
CREATE INDEX "events_geo_idx" ON "events" ("lat", "lng");
CREATE INDEX "events_host_idx" ON "events" ("host_id", "start_at");
CREATE INDEX "event_sessions_event_idx" ON "event_sessions" ("event_id", "start_at");
CREATE UNIQUE INDEX "event_registrations_uniq"
  ON "event_registrations" ("session_id", "user_id");
CREATE INDEX "event_registrations_session_idx"
  ON "event_registrations" ("session_id", "state", "created_at");
CREATE INDEX "event_registrations_user_idx"
  ON "event_registrations" ("user_id", "created_at");

-- 4. GUARDS ------------------------------------------------------------------

-- THE INVARIANT. Confirming past the ceiling is impossible, not merely unlikely.
--
-- Checked against the OVERSELL CEILING rather than against `capacity`, because a
-- free session is deliberately overbooked: free RSVPs no-show at 40-60%, and a hall
-- that shows "full" and then runs half empty is the failure a host actually notices.
-- `capacity` keeps meaning what the host said — the hall holds 200 — and the ceiling
-- is derived from it, so the two numbers never have to be reconciled by hand.
--
-- Integer division truncates, which is the same as the service's Math.floor. If the
-- two disagreed, one of them would be the bug.
ALTER TABLE "event_sessions" ADD CONSTRAINT "seats_within_capacity"
  CHECK ("capacity" IS NULL
         OR "seats_taken" <= ("capacity" * "oversell_bps") / 10000);

-- Never below 1x: a factor under 10000 would quietly refuse seats the host
-- advertised, which is the opposite failure and a worse one.
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_oversell_sane"
  CHECK ("oversell_bps" >= 10000);

-- A negative count means a decrement fired twice; it should surface here rather than
-- as "-2 seats left" on a page nobody can explain.
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_seats_non_negative"
  CHECK ("seats_taken" >= 0);

ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_span_valid"
  CHECK ("end_at" > "start_at");
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_price_non_negative"
  CHECK ("price_paise" >= 0);

ALTER TABLE "events" ADD CONSTRAINT "events_span_valid"
  CHECK ("end_at" > "start_at");

ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_seats_positive"
  CHECK ("seats" > 0);

-- A city-precision coordinate is the city centroid and says nothing about where the
-- event is. Requiring a pincode with a finer claim is what stops a host declaring
-- `exact` for a point they took from a dropdown.
ALTER TABLE "events" ADD CONSTRAINT "events_geo_precision_evidence"
  CHECK ("geo_precision" = 'city' OR "pincode" IS NOT NULL);

/*
 * THE TWO-TIER RULE, in the database.
 *
 * A devotee-listed event can never take money through the platform. That removes the
 * fake-ticketed-puja fraud class structurally — no code path, admin tool or psql
 * session can create one — rather than by remembering to check. A paid event needs a
 * host we have verified, which in practice means a purohit or an organisation.
 */
CREATE OR REPLACE FUNCTION assert_event_liability_tier() RETURNS trigger AS $$
BEGIN
  IF NEW.registration_mode IN ('ticketed', 'seva_slots') THEN
    IF NEW.host_kind = 'devotee' THEN
      RAISE EXCEPTION
        'a devotee-listed event cannot take money; it may be a listing only'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Hosted events are reviewed before they are published, always. A listing is
    -- moderated after the fact; something we take money for is not.
    IF NEW.state = 'published' AND NEW.verified_by IS NULL THEN
      RAISE EXCEPTION 'a paid event must be verified before it is published'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_liability_tier
  BEFORE INSERT OR UPDATE OF registration_mode, host_kind, state, verified_by ON "events"
  FOR EACH ROW EXECUTE FUNCTION assert_event_liability_tier();

/*
 * A session belongs inside its event's window.
 *
 * Nine days of a paath are nine sessions within one event, and a session outside the
 * event's own span is a transcription error that would otherwise show up as an event
 * "starting" before it starts.
 */
CREATE OR REPLACE FUNCTION assert_session_within_event() RETURNS trigger AS $$
DECLARE
  ev_start TIMESTAMPTZ;
  ev_end   TIMESTAMPTZ;
BEGIN
  SELECT start_at, end_at INTO ev_start, ev_end FROM events WHERE id = NEW.event_id;
  IF ev_start IS NULL THEN
    RAISE EXCEPTION 'event % does not exist', NEW.event_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.start_at < ev_start OR NEW.end_at > ev_end THEN
    RAISE EXCEPTION 'session % falls outside its event window', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_sessions_within_event
  BEFORE INSERT OR UPDATE OF start_at, end_at, event_id ON "event_sessions"
  FOR EACH ROW EXECUTE FUNCTION assert_session_within_event();

-- Only a free session may be registered for without a payment intent, and this is
-- the second half of the two-tier rule: it closes the path where a paid seat is
-- confirmed by a code path that forgot to charge for it.
CREATE OR REPLACE FUNCTION assert_paid_seat_has_payment() RETURNS trigger AS $$
DECLARE
  price BIGINT;
BEGIN
  IF NEW.state <> 'confirmed' THEN RETURN NEW; END IF;
  SELECT price_paise INTO price FROM event_sessions WHERE id = NEW.session_id;
  IF price > 0 AND NEW.payment_intent_id IS NULL THEN
    RAISE EXCEPTION 'a paid seat cannot be confirmed without a payment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_registrations_paid_seat
  BEFORE INSERT OR UPDATE OF state, payment_intent_id ON "event_registrations"
  FOR EACH ROW EXECUTE FUNCTION assert_paid_seat_has_payment();
