CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"git_ref" jsonb,
	"object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;