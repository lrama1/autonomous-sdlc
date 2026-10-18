CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"agent_role" text NOT NULL,
	"agent_definition_id" text NOT NULL,
	"agent_definition_version" integer NOT NULL,
	"engine" text NOT NULL,
	"model_alias" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"sponsor_person_id" uuid NOT NULL,
	"contributors" uuid[] DEFAULT '{}' NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch" text,
	"pr_number" integer,
	"session_ref" text,
	"park_reason" text,
	"budget_micros" bigint NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assumption" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"text" text NOT NULL,
	"impact" text DEFAULT 'low' NOT NULL,
	"state" text DEFAULT 'declared' NOT NULL,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"initiative_id" uuid,
	"source" text NOT NULL,
	"alias" text NOT NULL,
	"provider_model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "initiative" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"autonomy_mode" text DEFAULT 'balanced' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"budget_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiative_id" uuid NOT NULL,
	"run_id" uuid,
	"type" text NOT NULL,
	"checkpoint_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"context_card" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb,
	"recommendation" text,
	"default_value" text,
	"due_at" timestamp with time zone,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topic_key" text,
	"role_needed" text NOT NULL,
	"assigned_person_id" uuid,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"hard_stop" boolean DEFAULT false NOT NULL,
	"answer" jsonb,
	"answered_by" uuid,
	"answered_via" text,
	"answered_at" timestamp with time zone,
	"didnt_need_to_ask" boolean DEFAULT false NOT NULL,
	"standing_decision_id" uuid,
	"duplicate_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"access" text DEFAULT 'read_write' NOT NULL,
	"write_mode" text DEFAULT 'branch_pr' NOT NULL,
	"integration_branch" text DEFAULT 'main' NOT NULL,
	"protected_paths" text[] DEFAULT '{}' NOT NULL,
	"allowed_paths" text[],
	"model_policy" text DEFAULT 'any' NOT NULL,
	"verify_command" text DEFAULT 'npm run verify' NOT NULL,
	"github_installation_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_entry_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "run_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "run_event_run_seq_uq" UNIQUE("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "run_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standing_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'initiative' NOT NULL,
	"scope_id" uuid,
	"topic" text NOT NULL,
	"text" text NOT NULL,
	"created_from_interaction_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_sponsor_person_id_person_id_fk" FOREIGN KEY ("sponsor_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_repository_id_repository_entry_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assumption" ADD CONSTRAINT "assumption_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assumption" ADD CONSTRAINT "assumption_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assumption" ADD CONSTRAINT "assumption_decided_by_person_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_record" ADD CONSTRAINT "cost_record_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative" ADD CONSTRAINT "initiative_repository_id_repository_entry_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative" ADD CONSTRAINT "initiative_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_assigned_person_id_person_id_fk" FOREIGN KEY ("assigned_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_answered_by_person_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_token" ADD CONSTRAINT "run_token_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_initiative_idx" ON "agent_run" USING btree ("initiative_id");--> statement-breakpoint
CREATE INDEX "agent_run_state_idx" ON "agent_run" USING btree ("state");--> statement-breakpoint
CREATE INDEX "cost_record_run_idx" ON "cost_record" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "interaction_initiative_state_idx" ON "interaction" USING btree ("initiative_id","state");--> statement-breakpoint
CREATE INDEX "interaction_run_idx" ON "interaction" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "interaction_due_idx" ON "interaction" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "run_token_run_idx" ON "run_token" USING btree ("run_id");