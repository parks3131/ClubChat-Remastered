ALTER TABLE "messages" ADD COLUMN "linked_poll_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "linked_event_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "linked_meeting_id" uuid;--> statement-breakpoint
CREATE INDEX "messages_linked_poll" ON "messages" USING btree ("linked_poll_id") WHERE linked_poll_id is not null;--> statement-breakpoint
CREATE INDEX "messages_linked_event" ON "messages" USING btree ("linked_event_id") WHERE linked_event_id is not null;--> statement-breakpoint
CREATE INDEX "messages_linked_meeting" ON "messages" USING btree ("linked_meeting_id") WHERE linked_meeting_id is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_at_most_one_link" CHECK ((CASE WHEN linked_poll_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN linked_event_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN linked_meeting_id IS NOT NULL THEN 1 ELSE 0 END) <= 1);