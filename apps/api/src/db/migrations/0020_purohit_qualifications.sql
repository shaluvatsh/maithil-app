-- What a purohit has to show before we will look at them.
--
-- Verification used to rest on ONE document: a photo ID. Everything else was
-- optional, so "verified purohit" — the central claim on the home page of a service
-- that sends a stranger into a family's home — could mean an operator had seen a
-- single Aadhaar photo and clicked approve.
--
-- Three more document types, and the qualification the purohit is claiming.
ALTER TYPE kyc_type ADD VALUE IF NOT EXISTS 'address';
ALTER TYPE kyc_type ADD VALUE IF NOT EXISTS 'pan';
ALTER TYPE kyc_type ADD VALUE IF NOT EXISTS 'qualification';

-- The LEVEL, stored beside the profile, distinct from the certificate that proves
-- it. The certificate is a KYC record like any other and is purged 30 days after a
-- decision (ADR 0010); the level outlives it, because a reviewer looking at an old
-- approval needs to see what was claimed after the image is gone.
--
-- Postgres has no `CREATE TYPE IF NOT EXISTS`, and a bare CREATE TYPE makes this
-- whole file un-rerunnable: the moment it half-applies — which it did, locally, on
-- a database where the three enum values above exist and this type does too — every
-- later attempt dies here. That matters beyond a developer's laptop, because
-- `fly.toml` runs the migrations as the deploy's `release_command`: a migration
-- that cannot be re-run turns one bad apply into every subsequent deploy failing,
-- forever, with no way forward but hand surgery on production.
--
-- The exception block is the standard idiom for it. Every other statement in this
-- file already carried its own IF NOT EXISTS; this was the one that did not.
DO $$
BEGIN
  CREATE TYPE qualification_level AS ENUM (
    '10th', '12th', 'diploma', 'graduate', 'post_graduate', 'doctorate', 'pathshala'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE pandit_profiles ADD COLUMN IF NOT EXISTS
  highest_qualification qualification_level;
