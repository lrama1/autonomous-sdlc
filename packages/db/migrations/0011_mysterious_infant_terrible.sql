CREATE TABLE "preview_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"interaction_id" uuid,
	"initiative_id" uuid,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"url" text,
	"host_port" integer,
	"detail" text,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "preview_run" ADD CONSTRAINT "preview_run_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_run" ADD CONSTRAINT "preview_run_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_run" ADD CONSTRAINT "preview_run_started_by_person_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_run_pr_idx" ON "preview_run" USING btree ("repository","pr_number");