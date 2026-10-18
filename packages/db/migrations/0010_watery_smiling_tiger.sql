CREATE TABLE "bug_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"steps" text,
	"severity" text DEFAULT 'medium' NOT NULL,
	"reported_by" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"detail" text,
	"stage_start_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report" ADD CONSTRAINT "bug_report_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report" ADD CONSTRAINT "bug_report_reported_by_person_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report" ADD CONSTRAINT "bug_report_stage_start_id_stage_start_id_fk" FOREIGN KEY ("stage_start_id") REFERENCES "public"."stage_start"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_report_initiative_idx" ON "bug_report" USING btree ("initiative_id");