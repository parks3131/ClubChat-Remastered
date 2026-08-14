-- Nudge: an admin pushing one meetup at the whole club, and the cooldown that keeps it from
-- becoming the reason members turn push off.
--
-- The table body below is generated. The extension and the EXCLUDE constraint are hand-added,
-- because drizzle cannot express an exclusion constraint - see ADR-0030 and the note on
-- `meetupNudges` in schema.ts, which says the same thing so a reader of either finds it.

-- btree_gist is what lets one gist index hold `club_id WITH =` beside a range. Core Postgres
-- contrib, and supported on Neon, which is where this runs in production (SPEC/TECH/15).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "meetup_nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"meetup_id" uuid,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cooldown_until" timestamp with time zone DEFAULT now() + interval '1 hour' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meetup_nudges" ADD CONSTRAINT "meetup_nudges_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- SET NULL, not cascade, and the column is nullable so it can be. The cooldown is a fact about
-- the CLUB: deleting the meetup that was nudged must not hand back an early nudge.
ALTER TABLE "meetup_nudges" ADD CONSTRAINT "meetup_nudges_meetup_id_meetups_id_fk" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetup_nudges" ADD CONSTRAINT "meetup_nudges_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetup_nudges_by_club" ON "meetup_nudges" USING btree ("club_id","created_at");--> statement-breakpoint

-- One nudge per club per hour, enforced here rather than in the handler.
--
-- The rule is per CLUB, not per meetup and not per admin. Per meetup would let an admin post
-- seven meetups on Sunday and nudge all seven; per admin would let three admins take turns.
--
-- An EXCLUDE rather than a SELECT-then-INSERT because two admins tapping the bell in the same
-- second is precisely the case a read-then-write loses, and it is the likeliest way this gets
-- tested in the wild. The handler still reads the last nudge first - not for correctness, but so
-- the refusal can say WHEN the bell comes back rather than only that it is locked.
--
-- The window's end is the stored `cooldown_until` rather than `created_at + interval '1 hour'`,
-- because `timestamptz + interval` is STABLE and not IMMUTABLE - it reads the session time zone -
-- and an exclusion constraint is an index, which admits only immutable expressions. Two plain
-- columns make `tstzrange` immutable and the constraint legal.
ALTER TABLE "meetup_nudges" ADD CONSTRAINT "meetup_nudges_one_per_club_per_hour"
  EXCLUDE USING gist (
    "club_id" WITH =,
    tstzrange("created_at", "cooldown_until") WITH &&
  );
