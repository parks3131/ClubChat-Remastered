CREATE TABLE "club_bans" (
	"club_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_bans_club_id_user_id_pk" PRIMARY KEY("club_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "club_bans" ADD CONSTRAINT "club_bans_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_bans" ADD CONSTRAINT "club_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_bans" ADD CONSTRAINT "club_bans_banned_by_users_id_fk" FOREIGN KEY ("banned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_bans_by_user" ON "club_bans" USING btree ("user_id");