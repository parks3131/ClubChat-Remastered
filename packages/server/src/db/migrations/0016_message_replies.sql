ALTER TABLE "messages" ADD COLUMN "reply_to_seq" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_fk" FOREIGN KEY ("channel_id","reply_to_seq") REFERENCES "public"."messages"("channel_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_reply_to" ON "messages" USING btree ("channel_id","reply_to_seq") WHERE reply_to_seq is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_precedes" CHECK (reply_to_seq is null or reply_to_seq < seq);