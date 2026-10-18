CREATE TABLE "stage_start" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"key" text NOT NULL,
	"stage" text NOT NULL,
	"role" text NOT NULL,
	"source_interaction_id" uuid,
	"task" text NOT NULL,
	"state" text NOT NULL,
	"detail" text,
	"started_by" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_start_initiative_key" UNIQUE("initiative_id","key")
);
--> statement-breakpoint
ALTER TABLE "initiative" ADD COLUMN "auto_stages" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_start" ADD CONSTRAINT "stage_start_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_start" ADD CONSTRAINT "stage_start_source_interaction_id_interaction_id_fk" FOREIGN KEY ("source_interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_start" ADD CONSTRAINT "stage_start_started_by_person_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_start" ADD CONSTRAINT "stage_start_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;