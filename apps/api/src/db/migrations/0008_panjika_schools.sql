-- The panjika enum was Bengal-only.
--
-- `packages/region` was expanded pan-India and the twelve non-Bengal cities declare
-- `drik_generic` and `vikram_banaras` — values this enum has never contained. The
-- database therefore could not store a panchang for any of them.
--
-- What actually happened is worse than a failed insert. The materialiser fell back
-- to a hardcoded `bisuddha_siddhanta`, which every city could store, so rows were
-- written for Ahmedabad and Mumbai under a school those regions do not offer. The
-- read path lists schools from the region config, found no match, and reported
-- nothing published. Data existed, filed under a name nobody would ask for, and the
-- panchang was blank in every city but Kolkata with no error at any layer.
--
-- ADD VALUE is transactional from PG 12 as long as the new value is not used in the
-- same transaction, which is why this file only widens the type and the backfill
-- lives in the next migration.

ALTER TYPE panjika_school ADD VALUE IF NOT EXISTS 'vikram_banaras';
--> statement-breakpoint
ALTER TYPE panjika_school ADD VALUE IF NOT EXISTS 'tamil_vakya';
--> statement-breakpoint
ALTER TYPE panjika_school ADD VALUE IF NOT EXISTS 'drik_generic';
