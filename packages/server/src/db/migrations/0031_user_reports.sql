CREATE TABLE "user_reports" (
	"reporter_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	CONSTRAINT "user_reports_reporter_id_subject_id_pk" PRIMARY KEY("reporter_id","subject_id"),
	CONSTRAINT "user_reports_not_self" CHECK (reporter_id <> subject_id)
);
--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_reports_open" ON "user_reports" USING btree ("created_at" DESC NULLS LAST) WHERE dismissed_at is null;--> statement-breakpoint
CREATE INDEX "user_reports_by_subject" ON "user_reports" USING btree ("subject_id");