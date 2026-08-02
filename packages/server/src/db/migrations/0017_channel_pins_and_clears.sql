CREATE TABLE "channel_clears" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"cleared_before_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_clears_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id"),
	CONSTRAINT "channel_clears_seq_nonneg" CHECK ("channel_clears"."cleared_before_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel_pins" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_pins_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "channel_clears" ADD CONSTRAINT "channel_clears_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_clears" ADD CONSTRAINT "channel_clears_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;