-- The member link (ADR-0025), alongside the admin one every club already has.
--
-- Three statements rather than drizzle's one, because `ADD COLUMN ... NOT NULL` with no default
-- cannot land on a table that already has rows: every existing club needs its own token, and a
-- DEFAULT would give them all the SAME one, which is a unique-constraint failure at best and one
-- link into every club at worst.
--
-- The value is built from two uuids rather than `gen_random_bytes`, which lives in pgcrypto and
-- may not be installed. Two v4 uuids with the dashes removed is 64 hex characters - url-safe by
-- construction, and enough entropy that guessing one is not a strategy. Tokens minted by the
-- application stay base64url from 32 CSPRNG bytes; both are opaque and compared exactly, so the
-- two shapes coexist happily and only the backfilled ones look different.
ALTER TABLE "clubs" ADD COLUMN "member_invite_token" text;--> statement-breakpoint
UPDATE "clubs"
   SET "member_invite_token" =
       replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 WHERE "member_invite_token" IS NULL;--> statement-breakpoint
ALTER TABLE "clubs" ALTER COLUMN "member_invite_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_member_invite_token_unique" UNIQUE("member_invite_token");
