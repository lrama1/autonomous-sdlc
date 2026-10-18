CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"interaction_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_ref" jsonb,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "slack_user_id" text;--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "level_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "reminder_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "standing_decision" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_status_idx" ON "notification" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notification_person_idx" ON "notification" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "standing_decision" ADD CONSTRAINT "standing_decision_created_by_person_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_slack_user_id_unique" UNIQUE("slack_user_id");