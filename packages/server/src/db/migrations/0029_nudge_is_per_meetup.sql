-- The Nudge cooldown moves from the club to the meetup. See ADR-0031, which supersedes ADR-0030.
--
-- The rule was one nudge per CLUB per hour, which meant nudging Friday's morning run also
-- silenced Friday's evening social. Reported from real use: four meetups in a day are four
-- separate things to tell people about, and one clock across all of them is the wrong shape.
--
-- Everything about the mechanism is unchanged - still an EXCLUDE rather than a read-then-write,
-- still `cooldown_until` stored rather than computed, for the reasons ADR-0030 gives and which
-- ADR-0031 does not disturb. Only the first operand moves.
--
-- The DROP INDEX and CREATE INDEX below are generated; the two constraint statements are not,
-- because drizzle cannot express an exclusion constraint.

ALTER TABLE "meetup_nudges" DROP CONSTRAINT "meetup_nudges_one_per_club_per_hour";--> statement-breakpoint

-- `meetup_id` is nullable, and a NULL operand takes a row OUT of an exclusion constraint - which
-- is the behaviour this wants rather than a hole in it. A nudge whose meetup has since been
-- deleted blocks nothing, because there is no longer a meetup to nudge. That is the opposite of
-- what the club-wide rule needed, where the row had to keep blocking after its meetup was gone.
ALTER TABLE "meetup_nudges" ADD CONSTRAINT "meetup_nudges_one_per_meetup_per_hour"
  EXCLUDE USING gist (
    "meetup_id" WITH =,
    tstzrange("created_at", "cooldown_until") WITH &&
  );--> statement-breakpoint

-- The read is now "is THIS meetup cooling down", so the club index no longer serves it.
DROP INDEX "meetup_nudges_by_club";--> statement-breakpoint
CREATE INDEX "meetup_nudges_by_meetup" ON "meetup_nudges" USING btree ("meetup_id","cooldown_until");
