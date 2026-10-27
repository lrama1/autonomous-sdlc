CREATE TABLE "model_setting" (
	"alias" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_setting" ADD CONSTRAINT "model_setting_updated_by_person_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;