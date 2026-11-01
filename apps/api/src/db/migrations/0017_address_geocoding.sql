-- Address coordinates, and how much they can be trusted.
--
-- Every address created through the product lands on its CITY's centroid: the API
-- accepts an optional lat/lng and no client has ever sent one. That is survivable
-- for ranking (it biases proximity toward whoever is nearest the city centre) but
-- fatal for ADR 0013, where travel time between two addresses drives scheduling —
-- two addresses in Kolkata are literally the same point, so travel between them is
-- zero and any buffer computed from it is a fiction.
--
-- Three tiers, resolved in order: an exact coordinate the devotee supplied, the
-- centroid of their pincode, and the city centroid as the floor. `geo_precision`
-- records which one was used, so the scheduler can widen its margin on a coarse
-- point instead of trusting a number nobody measured.

CREATE TYPE "geo_precision" AS ENUM ('exact', 'pincode', 'city');
--> statement-breakpoint

ALTER TABLE "addresses"
  ADD COLUMN IF NOT EXISTS "geo_precision" "geo_precision" NOT NULL DEFAULT 'city';
--> statement-breakpoint

-- Pincode centroids. A pincode is a couple of km across inside a city, against a
-- city that is a couple of hundred square km — coarse for a doorstep, ample for a
-- travel estimate.
--
-- A table, not a constant in `packages/region`: ~19,000 rows for India, third-party
-- data with its own refresh cycle, and it has to be loadable without a deploy.
-- `source` identifies the dataset so a bad import can be replaced rather than
-- guessed at. Starting empty is valid — resolution falls back to the city centroid
-- and says so.
CREATE TABLE IF NOT EXISTS "pincode_centroids" (
  "pincode"    text PRIMARY KEY,
  "lat"        double precision NOT NULL,
  "lng"        double precision NOT NULL,
  "source"     text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pincode_centroids_lat_range" CHECK ("lat" BETWEEN -90 AND 90),
  CONSTRAINT "pincode_centroids_lng_range" CHECK ("lng" BETWEEN -180 AND 180),
  -- Six digits, first never zero. Rejects the malformed rows a bulk CSV import
  -- otherwise carries in silently.
  CONSTRAINT "pincode_centroids_format" CHECK ("pincode" ~ '^[1-9][0-9]{5}$')
);
