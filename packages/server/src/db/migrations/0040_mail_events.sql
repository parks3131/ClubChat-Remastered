-- What Resend tells us AFTER a message leaves, which nothing has ever recorded.
--
-- ADR-0020 left this open in as many words: "Resend has webhooks for both and nothing consumes
-- them, so a hard bounce still means a reset link went nowhere and nothing in the product knows."
-- `POST /webhooks/resend` now consumes them and this is where they land. ADR-0047 records the
-- decision, including the suppression list that was considered and deliberately not built.
--
-- Three things about the shape are load-bearing:
--
--  1. `mail_events_delivery` is UNIQUE on (provider_event_id, email) and it is the idempotency
--     key. Resend documents at-least-once delivery with retries at 5s, 5m, 30m, 2h, 5h and 10h,
--     so the same event WILL arrive twice; the insert is ON CONFLICT DO NOTHING against exactly
--     this index. The pair rather than the id alone because one delivery may name several
--     recipients, and each is its own row.
--
--  2. There is NO foreign key from `email` to `users`. The address that bounced is frequently one
--     that belongs to nobody - a member mistyped it at sign-up, which is the case this table
--     exists to surface - a member may change their address afterwards, and a cascade would
--     delete the evidence at the moment somebody is asking what happened to the account.
--
--  3. `kind` is constrained rather than trusted. The row is written from a payload that arrived
--     over the internet; the signature check decides whether to believe the sender, and this
--     decides whether to believe the shape.
--
-- Not built CONCURRENTLY, for the reason 0039 records: CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block and every migration here runs inside one. Irrelevant either way on
-- a table that starts empty.

CREATE TABLE "mail_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"email" text NOT NULL,
	"bounce_type" text,
	"detail" text,
	"provider_message_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_events_kind_valid" CHECK (kind in ('bounced', 'complained', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_events_delivery" ON "mail_events" USING btree ("provider_event_id","email");--> statement-breakpoint
CREATE INDEX "mail_events_by_email" ON "mail_events" USING btree ("email","occurred_at" DESC NULLS LAST);