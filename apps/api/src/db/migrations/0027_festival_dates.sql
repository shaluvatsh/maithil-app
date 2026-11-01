-- ---------------------------------------------------------------------------
-- Festival dates, transcribed per school.
--
-- The countdown needs to know when Durga Puja is. That is a lunar date — Ashwin
-- shukla shashthi to dashami — and this system cannot derive it: `panchang_days`
-- holds the tithi and nakshatra at sunrise, and `formatEraDate` produces a SOLAR
-- era date by arithmetic approximation. Neither knows the lunar month, so neither
-- can tell Ashwin shukla dashami from Chaitra shukla dashami.
--
-- Closing that gap by computing our own dates would be the wrong fix. ADR 0003 is
-- built on the fact that the panjikas disagree about exactly these dates, and that
-- Mithila's purnimant months move some of them outright. A date we computed would
-- be a third opinion contradicting the almanac the household actually keeps.
--
-- So: transcribed, like the Gupta Press muhurats, and scoped to the SCHOOL rather
-- than the city — a panjika's Vijaya Dashami is the same date in Kolkata and in
-- Guwahati. Which festivals a city marks is a separate question and lives in
-- `packages/region/src/festivals.ts`, where it needs no dates at all.
-- ---------------------------------------------------------------------------

CREATE TABLE "festival_dates" (
  "id"          TEXT PRIMARY KEY,
  "school"      "panjika_school" NOT NULL,
  "festival_id" TEXT NOT NULL,
  "date"        DATE NOT NULL,
  "ends_on"     DATE,
  "source"      "panchang_source" NOT NULL DEFAULT 'manual_panjika',
  "entered_by"  TEXT REFERENCES "users"("id"),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One date per festival per school per year. Re-transcribing a corrected date
-- replaces the row rather than adding a second, contradictory one.
CREATE UNIQUE INDEX "festival_dates_uniq"
  ON "festival_dates" ("school", "festival_id", "date");

-- The countdown's only query.
CREATE INDEX "festival_dates_upcoming" ON "festival_dates" ("school", "date");

-- A multi-day festival ends after it starts. Cheap, and it catches a transcription
-- that swapped the two columns — which is the most likely way this data goes wrong.
ALTER TABLE "festival_dates" ADD CONSTRAINT "festival_dates_span_valid"
  CHECK ("ends_on" IS NULL OR "ends_on" >= "date");
