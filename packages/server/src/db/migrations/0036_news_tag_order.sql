-- A post's tags remember the order they were written in.
--
-- `extractHashtags` returns them in written order and says in its own docstring that this is the
-- order the chips are drawn in. The read did not honour it: `hydratePosts` ordered by `tag`, so a
-- body reading "#longRun #bingRC" drew `#bingrc #longrun`. Found on a device rather than in a
-- test, because both orderings are deterministic and only one of them is the one somebody typed.
--
-- **The generated form of this migration would have failed.** drizzle-kit emits the column and
-- the UNIQUE together, and every existing row would hold the default 0 at that moment - so any
-- post with two tags violates the constraint before the backfill has a chance to run. The
-- backfill is therefore sited between them, which is the whole reason this file is hand-written.

ALTER TABLE "news_post_tags" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Existing rows get alphabetical positions, because written order is not recoverable from them:
-- the body they came from may since have been edited, and re-deriving would be a guess dressed
-- as a fact. Any post edited after this migration re-extracts and gets its real order.
UPDATE "news_post_tags" t
   SET "ordinal" = numbered.rn - 1
  FROM (
    SELECT "post_id", "tag",
           row_number() OVER (PARTITION BY "post_id" ORDER BY "tag") AS rn
      FROM "news_post_tags"
  ) numbered
 WHERE t."post_id" = numbered."post_id"
   AND t."tag" = numbered."tag";--> statement-breakpoint

ALTER TABLE "news_post_tags" ADD CONSTRAINT "news_post_tags_one_per_position" UNIQUE("post_id","ordinal");
