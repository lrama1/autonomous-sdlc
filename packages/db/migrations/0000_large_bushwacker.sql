CREATE TABLE "activity_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"initiative_id" uuid,
	"run_id" uuid,
	"interaction_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hat" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"deputy_person_id" uuid,
	"hours" jsonb,
	"out_of_office" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hat_person_role_uq" UNIQUE("person_id","role")
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"oidc_subject" text NOT NULL,
	"github_user_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_email_unique" UNIQUE("email"),
	CONSTRAINT "person_oidc_subject_unique" UNIQUE("oidc_subject")
);
--> statement-breakpoint
ALTER TABLE "hat" ADD CONSTRAINT "hat_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hat" ADD CONSTRAINT "hat_deputy_person_id_person_id_fk" FOREIGN KEY ("deputy_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_event_ts_idx" ON "activity_event" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "activity_event_initiative_idx" ON "activity_event" USING btree ("initiative_id");