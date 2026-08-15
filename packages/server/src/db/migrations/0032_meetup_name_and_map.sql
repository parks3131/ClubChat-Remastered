ALTER TABLE "meetups" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "location_notes" text;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "map_url" text;--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "map_lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "meetups" ADD COLUMN "map_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetup_point_is_whole" CHECK ((map_lat IS NULL) = (map_lng IS NULL));--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetup_point_on_earth" CHECK (map_lat IS NULL OR (map_lat BETWEEN -90 AND 90 AND map_lng BETWEEN -180 AND 180));