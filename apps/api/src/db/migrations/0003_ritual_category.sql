-- Ritual categories.
--
-- Browse was previously six decorative tiles that all linked to the same unfiltered
-- list, so every category showed an identical set of services. A category has to be
-- data on the ritual, not a label on a card.
--
-- Stored as text rather than an enum: the taxonomy is owned by packages/region so it
-- can differ by market, and a text column plus a CHECK-free index avoids a migration
-- every time a category is added.
ALTER TABLE rituals ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'festival-pujas';
CREATE INDEX IF NOT EXISTS rituals_category_idx ON rituals (category, sort_order);
