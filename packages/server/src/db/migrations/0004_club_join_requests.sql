CREATE TABLE "club_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_join_requests_status_valid" CHECK (status in ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "club_join_requests" ADD CONSTRAINT "club_join_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_join_requests" ADD CONSTRAINT "club_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_join_requests" ADD CONSTRAINT "club_join_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_join_requests_one_pending" ON "club_join_requests" USING btree ("club_id","user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "club_join_requests_by_club" ON "club_join_requests" USING btree ("club_id","status");