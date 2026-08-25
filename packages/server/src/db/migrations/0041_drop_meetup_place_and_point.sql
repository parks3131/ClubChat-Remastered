-- Three columns nothing collects and nothing draws, and the two constraints that guarded them.
--
-- ADR-0049. `location` stopped being collected on 2026-08-15 (ADR-0037) and was then read by the
-- nudge notification for ten more days, which pushed the literal word "null" to a club. The
-- `map_lat`/`map_lng` pair was kept the same day so an embedded map could return without a
-- migration; it never did, and every row a phone created has the pair empty because the Google
-- share sheet emits a short link that resolves to a place name rather than a point.
--
-- **This drops data**, which is why it says so here. `location` holds real text on rows created
-- before 2026-08-15 - 78 of 99 in a seeded development database, and none at all in production,
-- where the single meetup predates nothing. Anything still worth reading was backfilled into
-- `title` by 0032.
--
-- The constraints go first. Dropping a column takes its checks with it in Postgres, but naming
-- them makes the intent readable in the file rather than implied by a cascade.
ALTER TABLE "meetups" DROP CONSTRAINT IF EXISTS "meetup_point_is_whole";--> statement-breakpoint
ALTER TABLE "meetups" DROP CONSTRAINT IF EXISTS "meetup_point_on_earth";--> statement-breakpoint
ALTER TABLE "meetups" DROP COLUMN IF EXISTS "map_lat";--> statement-breakpoint
ALTER TABLE "meetups" DROP COLUMN IF EXISTS "map_lng";--> statement-breakpoint
ALTER TABLE "meetups" DROP COLUMN IF EXISTS "location";--> statement-breakpoint

-- The nudges already sent, whose stored params carry `location` and no `title`.
--
-- `renderNotification` reads params by key without validating them, so an old row would draw
-- "nudged the club about undefined" rather than throwing. There is one such row in production and
-- it is the bug report itself; deleting it is cheaper and more honest than teaching the renderer
-- to speak a shape that will never be written again. A nudge is the most disposable row in the
-- schema - it says "we are meeting today" about a day that has passed.
DELETE FROM "notifications" WHERE "type" = 'meetup_nudged';
