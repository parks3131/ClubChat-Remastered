ALTER TABLE "channels" ADD COLUMN "last_rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_channel_rev" ON "messages" USING btree ("channel_id","rev");--> statement-breakpoint

-- Backfill, and it is not optional.
--
-- The columns default to 0, and sync asks for `rev > <the client's mark>` starting at 0. Left at
-- the default, every message already in the table would be invisible to every sync forever: the
-- one row shape the new watermark cannot express is "changed at revision zero".
--
-- `rev = seq` rather than a fresh numbering: seq is already monotonic within its channel and
-- already >= 1 by the `messages_seq_positive` check, so it is a valid revision ordering for the
-- history that existed before revisions did. The two counters then advance together for appends,
-- and `last_rev` runs ahead of `last_seq` as mutations happen - which is the invariant the
-- allocator maintains from here on.
UPDATE "messages" SET "rev" = "seq";--> statement-breakpoint
UPDATE "channels" SET "last_rev" = "last_seq";
