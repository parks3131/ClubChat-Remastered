-- Routines become Weekly Meetups, and the activity type is deleted rather than generalised.
--
-- See ADR-0029. A meetup answers where, when and what: `location` and `meetup_time` are the
-- first two and are NOT NULL, and `description` is the third and is the only place what the
-- club is doing is ever recorded. There is no type, category or kind column, and the CHECK
-- that listed ten sports is dropped with nothing taking its place.
--
-- Written by hand rather than generated. drizzle-kit cannot tell a rename from a drop-and-
-- create without being asked interactively, and its answer to that question is the difference
-- between moving this data and destroying it.

ALTER TABLE "routine_workouts" RENAME TO "meetups";
--> statement-breakpoint
ALTER TABLE "meetups" RENAME COLUMN "workout_date" TO "meetup_date";
--> statement-breakpoint
ALTER TABLE "meetups" RENAME CONSTRAINT "routine_workouts_pkey" TO "meetups_pkey";
--> statement-breakpoint
ALTER TABLE "meetups" RENAME CONSTRAINT "routine_workouts_club_id_clubs_id_fk" TO "meetups_club_id_clubs_id_fk";
--> statement-breakpoint
ALTER TABLE "meetups" RENAME CONSTRAINT "routine_workouts_created_by_users_id_fk" TO "meetups_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "meetups" DROP CONSTRAINT "routine_workouts_activity_valid";
--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "location" text;
--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "meetup_time" time;
--> statement-breakpoint
UPDATE "meetups"
   SET "location"    = 'TBC',
       "meetup_time" = '00:00',
       "description" = CASE
         WHEN "description" IS NULL OR "description" = '' THEN "title"
         ELSE "title" || E'\n' || "description"
       END;
--> statement-breakpoint
ALTER TABLE "meetups" ALTER COLUMN "location" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "meetups" ALTER COLUMN "meetup_time" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "meetups" DROP COLUMN "activity_type";
--> statement-breakpoint
ALTER TABLE "meetups" DROP COLUMN "title";
--> statement-breakpoint
DROP INDEX "routine_workouts_by_club";
--> statement-breakpoint
CREATE INDEX "meetups_by_club" ON "meetups" USING btree ("club_id","meetup_date","meetup_time");
