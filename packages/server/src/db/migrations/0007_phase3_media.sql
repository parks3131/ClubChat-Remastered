CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"club_id" uuid,
	"channel_id" uuid,
	"uploader_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"variants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "media_objects_status_valid" CHECK (status in ('pending', 'ready', 'orphaned')),
	CONSTRAINT "media_objects_bytes_positive" CHECK (bytes > 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "document_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "document_size" integer;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_key" ON "media_objects" USING btree ("bucket","object_key");--> statement-breakpoint
CREATE INDEX "media_objects_stale_pending" ON "media_objects" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "media_objects_gallery" ON "media_objects" USING btree ("channel_id","created_at" DESC NULLS LAST) WHERE status = 'ready' and channel_id is not null;--> statement-breakpoint
CREATE INDEX "messages_with_media" ON "messages" USING btree ("channel_id","seq" DESC NULLS LAST) WHERE media_id is not null and deleted_at is null;