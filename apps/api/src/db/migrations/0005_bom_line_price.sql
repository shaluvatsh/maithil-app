-- Rename catalog_price_paise -> line_price_paise.
--
-- The column held the price FOR THE STATED QUANTITY: ₹180 against qty '250', unit 'g'
-- means ₹180 for 250 g of ghee. But sitting next to a `qty` column and named
-- "catalog price", it read like a unit rate, and both consumers multiplied:
--
--   SUM(catalog_price_paise * qty)   ->   18000 * 250  =  ₹45,000  for one ghee line
--
-- Satyanarayan Puja therefore quoted ₹75,820 of samagri against ₹1,500 of dakshina,
-- and because bomTotalPaise() feeds computePrice(), that figure was not merely
-- displayed — it would have been charged.
--
-- The name is the fix. `line_price_paise` cannot be read as a unit rate, so the
-- multiplication cannot look correct to the next person.

ALTER TABLE bom_items RENAME COLUMN catalog_price_paise TO line_price_paise;
--> statement-breakpoint

-- A line can be free (something the household already owns) but never negative.
ALTER TABLE bom_items
  DROP CONSTRAINT IF EXISTS bom_items_line_price_non_negative;
--> statement-breakpoint

ALTER TABLE bom_items
  ADD CONSTRAINT bom_items_line_price_non_negative
  CHECK (line_price_paise >= 0);
