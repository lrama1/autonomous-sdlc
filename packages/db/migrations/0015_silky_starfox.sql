CREATE TABLE "security_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"interaction_id" uuid,
	"initiative_id" uuid,
	"run_id" uuid,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"summary" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" text,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "security_review" ADD CONSTRAINT "security_review_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_review" ADD CONSTRAINT "security_review_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_review" ADD CONSTRAINT "security_review_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_review" ADD CONSTRAINT "security_review_started_by_person_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_review_pr_idx" ON "security_review" USING btree ("repository","pr_number","head_sha");