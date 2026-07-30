CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_scope_valid" CHECK (scope in ('club', 'race', 'eboard', 'dm')),
	CONSTRAINT "channels_dm_has_no_club" CHECK ((club_id is null) = (scope = 'dm'))
);
--> statement-breakpoint
CREATE TABLE "club_memberships" (
	"club_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_memberships_club_id_user_id_pk" PRIMARY KEY("club_id","user_id"),
	CONSTRAINT "club_memberships_role_valid" CHECK (role in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sport" text NOT NULL,
	"description" text,
	"join_policy" text DEFAULT 'open' NOT NULL,
	"invite_token" text NOT NULL,
	"invite_token_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clubs_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "eboard_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text DEFAULT 'Eboard & Council' NOT NULL,
	"description" text,
	CONSTRAINT "eboard_channels_club_id_unique" UNIQUE("club_id")
);
--> statement-breakpoint
CREATE TABLE "eboard_memberships" (
	"eboard_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eboard_memberships_eboard_id_user_id_pk" PRIMARY KEY("eboard_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"sender_id" uuid NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"body" text,
	"client_msg_id" uuid NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_seq_positive" CHECK (seq > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"partition_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "read_cursors" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_cursors_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bio" text,
	"city" text,
	"dob" date,
	"school" text,
	"anonymized_at" timestamp with time zone,
	"signin_blocked_at" timestamp with time zone,
	"is_platform_moderator" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eboard_channels" ADD CONSTRAINT "eboard_channels_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eboard_memberships" ADD CONSTRAINT "eboard_memberships_eboard_id_eboard_channels_id_fk" FOREIGN KEY ("eboard_id") REFERENCES "public"."eboard_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eboard_memberships" ADD CONSTRAINT "eboard_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_cursors" ADD CONSTRAINT "read_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_cursors" ADD CONSTRAINT "read_cursors_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_one_main_per_club" ON "channels" USING btree ("club_id") WHERE scope = 'club';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_scope_identity" ON "channels" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_memberships_one_owner" ON "club_memberships" USING btree ("club_id") WHERE role = 'owner';--> statement-breakpoint
CREATE INDEX "club_memberships_by_user" ON "club_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_seq" ON "messages" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency" ON "messages" USING btree ("channel_id","sender_id","client_msg_id");--> statement-breakpoint
CREATE INDEX "messages_channel_seq_desc" ON "messages" USING btree ("channel_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_pinned" ON "messages" USING btree ("channel_id","seq") WHERE pinned;--> statement-breakpoint
CREATE INDEX "messages_announcements" ON "messages" USING btree ("channel_id","seq") WHERE type = 'announcement';--> statement-breakpoint
CREATE INDEX "outbox_unprocessed" ON "outbox" USING btree ("partition_key","id") WHERE processed_at is null;