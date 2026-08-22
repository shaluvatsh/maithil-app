-- Repoint rows written under the wrong school.
--
-- Before 0008 the materialiser wrote every city's panchang under
-- `bisuddha_siddhanta`, because that was the only computable value the enum held.
-- For Kolkata that is correct — it is the city's own drik almanac. For everywhere
-- else it is a label the region never offers, so those rows were unreachable.
--
-- Both are drik schools: observed planetary positions, same astronomy, different
-- name. So the values are sound and only the label is wrong, which is why this is a
-- rename rather than a recompute.
--
-- Deleting and letting the nightly job rebuild would also work, and would leave
-- every city but Kolkata with no panchang until the job next ran.

UPDATE panchang_days
   SET school = 'drik_generic'
 WHERE school = 'bisuddha_siddhanta'
   AND city_id IN (SELECT id FROM cities WHERE slug <> 'kolkata');
--> statement-breakpoint
UPDATE panchang_intervals
   SET school = 'drik_generic'
 WHERE school = 'bisuddha_siddhanta'
   AND city_id IN (SELECT id FROM cities WHERE slug <> 'kolkata');
--> statement-breakpoint
UPDATE muhurat_flags
   SET school = 'drik_generic'
 WHERE school = 'bisuddha_siddhanta'
   AND city_id IN (SELECT id FROM cities WHERE slug <> 'kolkata');
