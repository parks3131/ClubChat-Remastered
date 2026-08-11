CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"moderator_id" uuid NOT NULL,
	"action" text NOT NULL,
	"subject_user_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_known" CHECK (action in ('suspend', 'reinstate', 'remove_message')),
	CONSTRAINT "moderation_actions_has_a_subject" CHECK (subject_user_id is not null or message_id is not null)
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_recent" ON "moderation_actions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_actions_by_subject" ON "moderation_actions" USING btree ("subject_user_id","created_at" DESC NULLS LAST);