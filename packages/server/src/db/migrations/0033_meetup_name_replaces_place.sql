-- A meetup is named, and no longer has to say where.
--
-- The founder replaced the place field with a pasted map link on 2026-08-15: "the link is the
-- place". Something still has to name a meetup, and with the place gone the title is the only
-- thing left that can - so it becomes required as the place stops being so.
--
-- The BACKFILL is the whole reason this file is hand-edited rather than as generated. Every one of
-- the meetups that already exists has a null title, because the column was three hours old and
-- optional, so `SET NOT NULL` on its own would fail on the first row it read. `location` is
-- exactly the right value to promote: it was the headline before a title existed, which is what
-- `meetupHeadline` and the calendar feed's COALESCE both did with it.
ALTER TABLE "meetups" ALTER COLUMN "location" DROP NOT NULL;--> statement-breakpoint

UPDATE "meetups" SET "title" = "location"
 WHERE "title" IS NULL OR btrim("title") = '';--> statement-breakpoint

-- Belt and braces for a row that somehow has neither: the constraint below must not be the thing
-- that discovers it, because a migration that fails halfway is worse than one that is careful.
UPDATE "meetups" SET "title" = 'Meetup' WHERE "title" IS NULL OR btrim("title") = '';--> statement-breakpoint

ALTER TABLE "meetups" ALTER COLUMN "title" SET NOT NULL;
