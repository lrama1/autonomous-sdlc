CREATE TABLE "build_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"design_interaction_id" uuid NOT NULL,
	"design_path" text NOT NULL,
	"design_sha" text NOT NULL,
	"state" text NOT NULL,
	"detail" text,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_plan_design_interaction_id_unique" UNIQUE("design_interaction_id")
);
--> statement-breakpoint
CREATE TABLE "build_task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"role" text NOT NULL,
	"stories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"done_when" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"run_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_task_plan_key" UNIQUE("plan_id","key")
);
--> statement-breakpoint
ALTER TABLE "build_plan" ADD CONSTRAINT "build_plan_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_plan" ADD CONSTRAINT "build_plan_design_interaction_id_interaction_id_fk" FOREIGN KEY ("design_interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_plan" ADD CONSTRAINT "build_plan_started_by_person_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_task" ADD CONSTRAINT "build_task_plan_id_build_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."build_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_task" ADD CONSTRAINT "build_task_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_plan_initiative_idx" ON "build_plan" USING btree ("initiative_id");--> statement-breakpoint
CREATE INDEX "build_task_run_idx" ON "build_task" USING btree ("run_id");