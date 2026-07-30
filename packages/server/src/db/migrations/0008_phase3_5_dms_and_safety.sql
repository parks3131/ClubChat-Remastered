CREATE TABLE "dm_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_conversations_pair" UNIQUE("user_a","user_b"),
	CONSTRAINT "dm_conversations_canonical_order" CHECK (user_a < user_b)
);
--> statement-breakpoint
CREATE TABLE "member_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "member_blocks_not_self" CHECK (blocker_id <> blocked_id)
);
--> statement-breakpoint
CREATE TABLE "message_reports" (
	"message_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	CONSTRAINT "message_reports_message_id_reporter_id_pk" PRIMARY KEY("message_id","reporter_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"moderator_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"from_seq" integer NOT NULL,
	"to_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_reads_window_ordered" CHECK (from_seq <= to_seq)
);
--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_blocks" ADD CONSTRAINT "member_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_blocks" ADD CONSTRAINT "member_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reads" ADD CONSTRAINT "moderation_reads_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reads" ADD CONSTRAINT "moderation_reads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reads" ADD CONSTRAINT "moderation_reads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dm_conversations_by_user_b" ON "dm_conversations" USING btree ("user_b");--> statement-breakpoint
CREATE INDEX "member_blocks_by_blocked" ON "member_blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "message_reports_open" ON "message_reports" USING btree ("created_at" DESC NULLS LAST) WHERE dismissed_at is null;--> statement-breakpoint
CREATE INDEX "moderation_reads_by_moderator" ON "moderation_reads" USING btree ("moderator_id","created_at" DESC NULLS LAST);