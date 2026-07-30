CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" text,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_type_valid" CHECK (type in ('race', 'practice', 'team_bonding', 'volunteer', 'other'))
);
--> statement-breakpoint
CREATE TABLE "car_group_members" (
	"car_group_id" uuid NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "car_group_members_car_group_id_user_id_pk" PRIMARY KEY("car_group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "car_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"incharge_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "car_groups_id_race" UNIQUE("id","race_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eboard_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text,
	"media_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_posts_not_empty" CHECK (body is not null or media_id is not null)
);
--> statement-breakpoint
CREATE TABLE "news_reactions" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	CONSTRAINT "news_reactions_post_id_user_id_emoji_pk" PRIMARY KEY("post_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"vote_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "poll_options_count_non_negative" CHECK (vote_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"poll_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"allow_multiple" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_option_id_user_id_pk" PRIMARY KEY("option_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"question" text NOT NULL,
	"allow_multiple" boolean DEFAULT false NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"closing_soon_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polls_id_allow_multiple" UNIQUE("id","allow_multiple"),
	CONSTRAINT "polls_scope_valid" CHECK (scope in ('club', 'race', 'eboard'))
);
--> statement-breakpoint
CREATE TABLE "race_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "race_join_requests_status_valid" CHECK (status in ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "race_memberships" (
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "race_memberships_race_id_user_id_pk" PRIMARY KEY("race_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "race_pins" (
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "race_pins_race_id_user_id_pk" PRIMARY KEY("race_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "races" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"race_date" date NOT NULL,
	"meet_description" text,
	"meet_location_url" text,
	"meet_hotel_url" text,
	"meet_photos_url" text,
	"meet_results_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"workout_date" date NOT NULL,
	"activity_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_workouts_activity_valid" CHECK (activity_type in ('run', 'trail_run', 'bike', 'swim', 'strength',
                            'hybrid_fitness', 'indoor_climb', 'bouldering', 'xc_ski', 'other'))
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_group_members" ADD CONSTRAINT "car_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_group_members" ADD CONSTRAINT "car_group_members_car_group_id_race_id_car_groups_id_race_id_fk" FOREIGN KEY ("car_group_id","race_id") REFERENCES "public"."car_groups"("id","race_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_groups" ADD CONSTRAINT "car_groups_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_groups" ADD CONSTRAINT "car_groups_incharge_user_id_users_id_fk" FOREIGN KEY ("incharge_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_eboard_id_eboard_channels_id_fk" FOREIGN KEY ("eboard_id") REFERENCES "public"."eboard_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_posts" ADD CONSTRAINT "news_posts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_posts" ADD CONSTRAINT "news_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_reactions" ADD CONSTRAINT "news_reactions_post_id_news_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."news_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_reactions" ADD CONSTRAINT "news_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_allow_multiple_polls_id_allow_multiple_fk" FOREIGN KEY ("poll_id","allow_multiple") REFERENCES "public"."polls"("id","allow_multiple") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_join_requests" ADD CONSTRAINT "race_join_requests_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_join_requests" ADD CONSTRAINT "race_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_join_requests" ADD CONSTRAINT "race_join_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_memberships" ADD CONSTRAINT "race_memberships_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_memberships" ADD CONSTRAINT "race_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_pins" ADD CONSTRAINT "race_pins_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_pins" ADD CONSTRAINT "race_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "races" ADD CONSTRAINT "races_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_workouts" ADD CONSTRAINT "routine_workouts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_workouts" ADD CONSTRAINT "routine_workouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_events_by_club" ON "calendar_events" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "car_group_members_one_per_race" ON "car_group_members" USING btree ("race_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "car_groups_race_number" ON "car_groups" USING btree ("race_id","number");--> statement-breakpoint
CREATE INDEX "meetings_by_eboard" ON "meetings" USING btree ("eboard_id","starts_at");--> statement-breakpoint
CREATE INDEX "news_posts_by_club" ON "news_posts" USING btree ("club_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "poll_options_position" ON "poll_options" USING btree ("poll_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_votes_single_choice" ON "poll_votes" USING btree ("poll_id","user_id") WHERE not allow_multiple;--> statement-breakpoint
CREATE INDEX "polls_by_scope" ON "polls" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "polls_closing_soon" ON "polls" USING btree ("closes_at") WHERE closed_at is null and closing_soon_notified_at is null and closes_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "race_join_requests_one_pending" ON "race_join_requests" USING btree ("race_id","user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "race_memberships_by_user" ON "race_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "races_by_club" ON "races" USING btree ("club_id","race_date");--> statement-breakpoint
CREATE INDEX "routine_workouts_by_club" ON "routine_workouts" USING btree ("club_id","workout_date");